import {Router} from "express";
import User from "../../models/rms/User.js";
import Deposit from "../../models/rms/Deposit.js"
import Withdraw from "../../models/rms/Withdraw.js"
import ECheck from "../../models/rms/ECheck.js"
import Transfer from "../../models/rms/Transfer.js"
import Other_Bank_Transfer from "../../models/rms/Other_Bank_Transfer.js"
import Air_Ticket_Payment from "../../models/rms/Air_Ticket_Payment.js"
import Biometric from "../../models/rms/Biometric.js"
import OTP from "../../models/rms/OTP.js"
import VerifiedSession from "../../models/rms/VerifiedSession.js"
import mongoose from 'mongoose';
import auth from "../../middleware/rms/auth.js";
import roleCheck from "../../middleware/rms/roleCheck.js";
import oracledb from 'oracledb';
import { executeQuery } from "../../lib/db.js";
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import * as FlexcubeTransactionService from '../../services/FlexcubeTransactionService.js';
import CustomerCategoryLimit from '../../models/rms/CustomerCategoryLimit.js';
import MakerCheckerThreshold from '../../models/rms/MakerCheckerThreshold.js';
import crypto from 'crypto';
import { otpLimiter, otpVerifyLimiter } from '../../middleware/rms/rateLimiter.js';
import { encryptAccountNumber, decryptAccountToken, extractCIF } from '../../utils/rms/accountEncryption.js';
import { decryptPayload } from '../../utils/rms/payloadDecryption.js';

// ============================================
// SESSION VALIDATION HELPER
// Validates session token and checks CIF ownership of account.
// Returns the session if valid, or null with error response sent.
// ============================================
async function validateTransactionSession(body, res) {
    const { sessionToken, account_number } = body;

    // If no sessionToken provided, allow (for direct account number entry flow)
    if (!sessionToken) return true;

    try {
        const session = await VerifiedSession.findOne({ session_token: sessionToken });
        if (!session) {
            res.status(401).json({
                error: true,
                message: "Session expired. Please re-verify your identity."
            });
            return false;
        }

        // If account_number provided, verify it belongs to the session's CIF
        if (account_number) {
            const accountCif = extractCIF(account_number.toString().trim());
            if (accountCif !== session.cif) {
                res.status(403).json({
                    error: true,
                    message: "Account does not belong to the verified customer. Unauthorized."
                });
                return false;
            }
        }

        // Remove sessionToken from body so it doesn't leak into MongoDB records
        delete body.sessionToken;

        return true;
    } catch (err) {
        console.error("[VALIDATE_SESSION] Error:", err.message);
        res.status(500).json({
            error: true,
            message: "Session validation error"
        });
        return false;
    }
}

// Fingerprint service paths
const __filename_fp = fileURLToPath(import.meta.url);
const __dirname_fp = path.dirname(__filename_fp);
const FINGERPRINT_SERVICE_PATH = path.join(__dirname_fp, '../../services/fingerprint');
// Use system temp directory to avoid triggering nodemon restart
const FINGERPRINT_DB_PATH = path.join(os.tmpdir(), 'fingerprint_db.json');

// Helper function to run ZKCapture.exe verify command for 1:1 matching
// Uses temp files to avoid command line length issues with Base64 templates
async function verifyFingerprint(template1, template2) {
    return new Promise((resolve, reject) => {
        const zkCapturePath = path.join(FINGERPRINT_SERVICE_PATH, 'ZKCapture.exe');

        if (!fs.existsSync(zkCapturePath)) {
            reject(new Error('ZKCapture.exe not found'));
            return;
        }

        // Write templates to temp files to avoid command line issues
        const tempDir = os.tmpdir();
        const template1Path = path.join(tempDir, `fp_template1_${Date.now()}.txt`);
        const template2Path = path.join(tempDir, `fp_template2_${Date.now()}.txt`);

        try {
            fs.writeFileSync(template1Path, template1);
            fs.writeFileSync(template2Path, template2);
        } catch (e) {
            reject(new Error('Failed to write temp files'));
            return;
        }

        // Use verifyfile command with file paths
        const proc = spawn(zkCapturePath, ['verifyfile', template1Path, template2Path]);
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            // Clean up temp files
            try { fs.unlinkSync(template1Path); } catch (e) {}
            try { fs.unlinkSync(template2Path); } catch (e) {}

            try {
                // Find JSON in output
                const jsonStart = stdout.indexOf('{');
                const jsonEnd = stdout.lastIndexOf('}');
                if (jsonStart !== -1 && jsonEnd !== -1) {
                    const jsonStr = stdout.substring(jsonStart, jsonEnd + 1);
                    const result = JSON.parse(jsonStr);
                    resolve(result);
                } else {
                    reject(new Error(`No JSON in output: ${stdout}`));
                }
            } catch (e) {
                reject(new Error(`Failed to parse result: ${stdout}`));
            }
        });

        proc.on('error', (err) => {
            // Clean up temp files
            try { fs.unlinkSync(template1Path); } catch (e) {}
            try { fs.unlinkSync(template2Path); } catch (e) {}
            reject(err);
        });
    });
}

// Fast 1:N fingerprint identification using ZK SDK's DBIdentify
// Much faster than looping through 1:1 verifications (~50,000+ matches/second)
async function identifyFingerprint(queryTemplate, biometrics) {
    return new Promise((resolve, reject) => {
        const zkCapturePath = path.join(FINGERPRINT_SERVICE_PATH, 'ZKCapture.exe');

        if (!fs.existsSync(zkCapturePath)) {
            reject(new Error('ZKCapture.exe not found'));
            return;
        }

        // Prepare fingerprint database JSON
        const fingerprintDb = {
            fingerprints: biometrics.map(b => ({
                cif: b.cif,
                template: b.fingerprint_template,
                finger_position: b.finger_position,
                customer_name: b.customer_name
            }))
        };

        // Write both query template and database to temp files
        const tempDir = os.tmpdir();
        const timestamp = Date.now();
        const dbPath = path.join(tempDir, `fp_db_${timestamp}.json`);
        const queryPath = path.join(tempDir, `fp_query_${timestamp}.txt`);

        try {
            fs.writeFileSync(dbPath, JSON.stringify(fingerprintDb));
            fs.writeFileSync(queryPath, queryTemplate);
        } catch (e) {
            reject(new Error('Failed to write temp files'));
            return;
        }

        // Use identifyfile command to read query template from file (avoids command line length issues)
        const proc = spawn(zkCapturePath, ['identifyfile', queryPath, dbPath]);
        let stdout = '';
        let stderr = '';

        proc.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        proc.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        proc.on('close', (code) => {
            // Clean up temp files
            try { fs.unlinkSync(dbPath); } catch (e) {}
            try { fs.unlinkSync(queryPath); } catch (e) {}

            try {
                // Find JSON in output
                const jsonStart = stdout.indexOf('{');
                const jsonEnd = stdout.lastIndexOf('}');
                if (jsonStart !== -1 && jsonEnd !== -1) {
                    const jsonStr = stdout.substring(jsonStart, jsonEnd + 1);
                    const result = JSON.parse(jsonStr);
                    resolve(result);
                } else {
                    reject(new Error(`No JSON in output: ${stdout}`));
                }
            } catch (e) {
                reject(new Error(`Failed to parse result: ${stdout}`));
            }
        });

        proc.on('error', (err) => {
            // Clean up temp files
            try { fs.unlinkSync(dbPath); } catch (e) {}
            try { fs.unlinkSync(queryPath); } catch (e) {}
            reject(err);
        });
    });
} 





/**
 * Generate a unique Customer_Unique_Number server-side.
 * Format: 10-character alphanumeric (A-Z, 0-9) using crypto.
 * 36^10 = ~3.6 quadrillion combinations — practically unguessable.
 * Checks all transaction collections for collisions before returning.
 */
const ALPHANUM_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no ambiguous 0/O/1/I
function generateSecureCode(length = 10) {
    const bytes = crypto.randomBytes(length);
    let result = '';
    for (let i = 0; i < length; i++) {
        result += ALPHANUM_CHARS[bytes[i] % ALPHANUM_CHARS.length];
    }
    return result;
}

async function generateUniqueCustomerNumber() {
    const MAX_RETRIES = 10;
    for (let i = 0; i < MAX_RETRIES; i++) {
        const num = generateSecureCode(10);
        // Check all collections for duplicates
        const [dep, wit, trn, obt, eck, atp] = await Promise.all([
            Deposit.findOne({ Customer_Unique_Number: num }).lean(),
            Withdraw.findOne({ Customer_Unique_Number: num }).lean(),
            Transfer.findOne({ Customer_Unique_Number: num }).lean(),
            Other_Bank_Transfer.findOne({ Customer_Unique_Number: num }).lean(),
            ECheck.findOne({ Customer_Unique_Number: num }).lean(),
            Air_Ticket_Payment.findOne({ Customer_Unique_Number: num }).lean(),
        ]);
        if (!dep && !wit && !trn && !obt && !eck && !atp) {
            return num;
        }
    }
    // Fallback: 12 chars for extra safety
    return generateSecureCode(12);
}

/**
 * Check account available balance from Flexcube Oracle DB.
 * Returns { success, balance } or { success: false, error }.
 */
async function getAccountBalance(accountNumber) {
    const query = `
        SELECT AB.ACY_WITHDRAWABLE_BAL AS AVAILABLE_BALANCE
        FROM fcubsprd.STTM_ACCOUNT_BALANCE AB
        WHERE AB.CUST_AC_NO = :1`;
    const result = await executeQuery(query, [accountNumber]);
    if (!result.success || !result.data || result.data.length === 0) {
        return { success: false, error: 'Could not retrieve account balance' };
    }
    return { success: true, balance: parseFloat(result.data[0].AVAILABLE_BALANCE) };
}

const router = Router();


// router.post("/deposit", async(req,res,next)=>{
//     try {
  
//         const {
//             acc_holder_name,
//             amount_in_words,
//             amount_in_figures,
//             source_of_funds,
//             signature, 
//             account_number,
//             deposited_by,
//             depositor_address,
//             account_type,
//             Customer_Unique_Number,
//             system,
//             branch
//         } = req.body;

       
//         let correctedAccountType;
//         switch(account_type.toLowerCase()) {
//             case 'savings':
//                 correctedAccountType = 'Saving Account';
//                 break;
//             case 'current':
//                 correctedAccountType = 'Demand/ Current Deposit Account';
//                 break;
//             case 'special':
//                 correctedAccountType = 'Special Demand Deposit Account';
//                 break;
//             default:
//                 correctedAccountType = 'Saving Account';
//         }

//         // Create new deposit object
//         const newDeposit = new Deposit({
//             acc_holder_name,
//             amount_in_words,
//             amount_in_figures,
//             source_of_funds,
//             signature,  // Changed: directly use signature
//             account_number,
//             deposited_by,
//             depositor_address: {
//                 city: depositor_address?.CITY?.toLowerCase() || '',
//                 subcity: depositor_address?.SUBCITY?.toLowerCase() || '',
//                 woreda: depositor_address?.WOREDA?.toLowerCase() || '',
//                 house_number: depositor_address?.HOUSE_NUMBER || '',
//                 telephone: depositor_address?.TELEPHONE || ''
//             },
//             account_type: correctedAccountType,
//             Customer_Unique_Number,
//             status: system ? 'pending_assignment' : 'requested'
//         });

//         // Save to database
//         await newDeposit.save();

//         if (system) {
//             try {
//                 const assignmentDetails = await assignTellerBySystem(branch);
//                 await Deposit.updateOne(
//                     { _id: newDeposit._id },
//                     { $set: assignmentDetails }
//                 );
//             } catch (assignError) {
//                 console.error("[AUTO_ASSIGNMENT] Failed:", assignError.message);
//                 // Continue with creation even if assignment fails
//             }
//         }

//         res.status(201).json({ 
//             error: false, 
//             message: "Deposit request created successfully",
//             data: {
//                 Queue_number: newDeposit.Queue_number,
//                 request_date: newDeposit.request_date
//             }
//         });

//     } catch(e) {
//         console.log("Error", e);
//         res.status(400).json({ 
//             error: true, 
//             message: e.message || "Could Not Do the Operation"
//         });
//     }
// });

// router.post("/withdraw", async(req,res,next)=>{
//     try {

//         console.log("Withdraw", req.body);
  
//         const {
//             acc_holder_name,
//             amount_in_words,
//             amount_in_figures,
//             source_of_funds,
//             signature, 
//             account_number,
//             deposited_by,
//             depositor_address,
//             account_type,
//             Customer_Unique_Number,
//         } = req.body;

       
//         let correctedAccountType;
//         switch(account_type.toLowerCase()) {
//             case 'savings':
//                 correctedAccountType = 'Saving Account';
//                 break;
//             case 'current':
//                 correctedAccountType = 'Demand/ Current Deposit Account';
//                 break;
//             case 'special':
//                 correctedAccountType = 'Special Demand Deposit Account';
//                 break;
//             default:
//                 correctedAccountType = 'Saving Account';
//         }

//         // Create new deposit object
//         const newWithdraw = new Withdraw({
//             acc_holder_name,
//             amount_in_words,
//             amount_in_figures,
//             source_of_funds,
//             signature,  
//             account_number,
//             deposited_by,
//             depositor_address: {
//                 city: depositor_address?.CITY?.toLowerCase() || '',
//                 subcity: depositor_address?.SUBCITY?.toLowerCase() || '',
//                 woreda: depositor_address?.WOREDA?.toLowerCase() || '',
//                 house_number: depositor_address?.HOUSE_NUMBER || '',
//                 telephone: depositor_address?.TELEPHONE || ''
//             },
//             account_type: correctedAccountType,
//             Customer_Unique_Number,
//         });

//         // Save to database
//         await newWithdraw.save();

//         res.status(201).json({ 
//             error: false, 
//             message: "Deposit request created successfully",
//             data: {
//                 Queue_number: newWithdraw.Queue_number,
//                 request_date: newWithdraw.request_date
//             }
//         });

//     } catch(e){
//         console.log("Error",e)
//         res.status(400).json({ error: false, message: "Could Not Do the Operation " });
//     }

// })
// router.post("/transfer", async(req,res,next)=>{
//     try {
//         console.log("Transfer", req.body);
  
//         const {
//             acc_holder_name,
//             amount_in_words,
//             amount_in_figures,
//             source_of_funds,
//             signature, 
//             account_number,
//             beneficiary_account_number,  // Added
//             beneficiary_branch,          // Added
//             beneficiary_name,            // Added
//             payment_narration,           // Added
//             account_type,
//             Customer_Unique_Number,
//         } = req.body;

//         // Fix the account type to match enum values
//         let correctedAccountType;
//         switch(account_type.toLowerCase()) {
//             case 'savings':
//                 correctedAccountType = 'Saving Account';
//                 break;
//             case 'current':
//                 correctedAccountType = 'Demand/ Current Deposit Account';
//                 break;
//             case 'special':
//                 correctedAccountType = 'Special Demand Deposit Account';
//                 break;
//             default:
//                 correctedAccountType = 'Saving Account';
//         }

//         // Create new transfer object with all required fields
//         const newTransfer = new Transfer({
//             acc_holder_name,
//             amount_in_words,
//             amount_in_figures,
//             source_of_funds,
//             signature,
//             account_number,
//             beneficiary_account_number,  // Added
//             beneficiary_branch,          // Added
//             beneficiary_name,            // Added
//             payment_narration,           // Added
//             account_type: correctedAccountType,
//             Customer_Unique_Number,
//             request_type: 'Transfer',    // Added default value
//             status: 'requested'          // Added default value
//         });

//         // Save to database
//         await newTransfer.save();

//         res.status(201).json({ 
//             error: false, 
//             message: "Transfer request created successfully",
//             data: {
//                 Queue_number: newTransfer.Queue_number,
//                 request_date: newTransfer.request_date
//             }
//         });

//     } catch(e) {
//         console.log("Error", e);
//         res.status(400).json({ 
//             error: true,  // Changed to true
//             message: e.message || "Could Not Do the Operation"  // Added error message
//         });
//     }
// });

// router.post("/other_bank_transfer", async(req,res,next)=>{
//     try {
//         console.log("other_bank_transfer", req.body);
  
//         const {
//             acc_holder_name,
//             amount_in_words,
//             amount_in_figures,
//             acc_holder_branch,
//             address,
//             telephone,
//             transfer_type,
//             beneficiary_bank,
//             signature, 
//             account_number,
//             beneficiary_account_number,
//             beneficiary_branch,         
//             beneficiary_name,            
//             account_type,
//             Customer_Unique_Number,
//         } = req.body;

//         // Fix the account type to match enum values
//         let correctedAccountType;
//         switch(account_type.toLowerCase()) {
//             case 'savings':
//                 correctedAccountType = 'Saving Account';
//                 break;
//             case 'current':
//                 correctedAccountType = 'Demand/ Current Deposit Account';
//                 break;
//             case 'special':
//                 correctedAccountType = 'Special Demand Deposit Account';
//                 break;
//             default:
//                 correctedAccountType = 'Saving Account';
//         }

//         // Create new transfer object with all required fields
//         const newOtherBankTransfer = new Other_Bank_Transfer({
//             acc_holder_name,
//             amount_in_words,
//             amount_in_figures,
//             beneficiary_bank,
//             signature,
//             account_number,
//             acc_holder_branch,
//             address,
//             telephone,
//             transfer_type,
//             beneficiary_account_number, 
//             beneficiary_branch,          
//             beneficiary_name,           
//             account_type: correctedAccountType,
//             Customer_Unique_Number,
//             status: 'requested'   
//         });

//         // Save to database
//         await newOtherBankTransfer.save();

//         res.status(201).json({ 
//             error: false, 
//             message: "Other Bank Transfer request created successfully",
//             data: {
//                 Queue_number: newOtherBankTransfer.Queue_number,
//                 request_date: newOtherBankTransfer.request_date
//             }
//         });

//     } catch(e){
//         console.log("Error",e)
//         res.status(400).json({ error: false, message: "Could Not Do the Operation " });
//     }

// })
































router.post("/transaction_reassigned", auth, roleCheck(["Admin", "Authorizer"]), async (req, res, next) => {
    try {
        const user = await User.findById(req.user._id).lean();
        if (!user) {
            return res.status(400).json({ 
                error: true, 
                message: "User not found" 
            });
        }

        const { transactions, assignedUser } = req.body;

        if (transactions.length === 0) {
            return res.status(400).json({ 
                error: true, 
                message: "Select at least one transaction" 
            });
        }

        const updatePromises = []; // Array to hold promises for all updates

        for (const transaction of transactions) {
            let Model;
            const type = transaction.transactionType.toLowerCase();

            switch (type) {
                case "withdraw":
                    Model = Withdraw;
                    break;
                case "echeck":
                case "e-check":  // Handle both old and new format
                    Model = ECheck;
                    break;
                case "deposit":
                    Model = Deposit;
                    break;
                case "air_ticket_payment":
                    Model = Air_Ticket_Payment;
                    break;
                case "transfer":
                    Model = Transfer;
                    break;
                case "other_bank_transfer":
                    Model = Other_Bank_Transfer;
                    break;
                default:
                    console.warn(`Unknown transaction type: ${type} for transaction ID: ${transaction.id}`);
                    continue; // Skip to the next iteration
            }

            // Prepare the update object
            let update = {
                assigned_to: assignedUser,
                reassigned_by: user.user, // New field
                reassigned_Date: Date.now() // New field
            };

            // Push the update promise to the array
            updatePromises.push(Model.findByIdAndUpdate(transaction.id, update));
        }

        // Wait for all updates to complete
        await Promise.all(updatePromises);

        return res.status(200).json({ 
            success: true, 
            message: "Transactions reassigned successfully" 
        });
    } catch (e) {
        console.error("[TRANSACTION_REASSIGN] Error:", e.message);
        return res.status(500).json({
            error: true,
            message: "An error occurred while processing the request."
        });
    }
});









router.get("/get_assigned_transaction_per_brnach", auth, roleCheck(["Admin", "Authorizer"]), async(req, res, next) => {
    try {
        // Get current user
        const user = await User.findById(req.user._id).lean();
        if (!user) {
            return res.status(400).json({ 
                error: true, 
                message: "User not found" 
            });
        }

        // Get today's date at midnight
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Query parameters for filtering
        const dateFilter = {
            request_date: {
                $gte: today,
                $lt: tomorrow
            }
        };

        // Fetch transactions from all models
        const [deposits, withdraws, echecks, transfers, otherBankTransfers, airTicketPayments] = await Promise.all([
            Deposit.find({
                branch: user.branch,
                status: "assigned",
                ...dateFilter
            }).sort({ request_date: -1 }),

            Withdraw.find({
                branch: user.branch,
                status: "assigned",
                ...dateFilter
            }).sort({ request_date: -1 }),

            ECheck.find({
                branch: user.branch,
                status: "assigned",
                ...dateFilter
            }).sort({ request_date: -1 }),

            Transfer.find({
                branch: user.branch,
                status: "assigned",
                ...dateFilter
            }).sort({ request_date: -1 }),

            Other_Bank_Transfer.find({
                branch: user.branch,
                status: "assigned",
                ...dateFilter
            }).sort({ request_date: -1 }),

            Air_Ticket_Payment.find({
                branch: user.branch,
                status: "assigned",
                ...dateFilter
            }).sort({ request_date: -1 })
        ]);

        // Combine all transactions
        const transformedTransactions = [
            ...deposits.map(t => ({
                ...t.toObject(),
                transactionType: 'deposit'
            })),
            ...withdraws.map(t => ({
                ...t.toObject(),
                transactionType: 'withdraw'
            })),
            ...echecks.map(t => ({
                ...t.toObject(),
                transactionType: 'echeck'
            })),
            ...transfers.map(t => ({
                ...t.toObject(),
                transactionType: 'transfer'
            })),
            ...otherBankTransfers.map(t => ({
                ...t.toObject(),
                transactionType: 'other_bank_transfer'
            })),
            ...airTicketPayments.map(t => ({
                ...t.toObject(),
                transactionType: 'air_ticket_payment'
            }))
        ];

        // Get unique account numbers
        const accountNumbers = [...new Set(transformedTransactions.map(t => t.account_number))];

        // Fetch images from Oracle DB
        const imagesQuery = `
            SELECT 
                CA.CUST_AC_NO,
                CI.IMAGE_TEXT AS PROFILE_IMAGE,
                SI.SIG_TEXT AS SIGN_IMAGE
            FROM fcubsprd.STTM_CUST_ACCOUNT CA
            LEFT JOIN fcubsprd.STTM_CUST_IMAGE CI ON CA.CUST_NO = CI.CUSTOMER_NO
            LEFT JOIN fcubsprd.svtm_cif_sig_det SI ON CA.CUST_NO = SI.CIF_ID
            WHERE CA.CUST_AC_NO IN (${accountNumbers.map((_, i) => `:${i + 1}`).join(',')})
        `;

        const imagesResult = await executeQuery(
            imagesQuery,
            accountNumbers,
            {
                fetchInfo: {
                    PROFILE_IMAGE: { type: oracledb.STRING },
                    SIGN_IMAGE: { type: oracledb.STRING }
                }
            }
        );

        // Create a map of account numbers to their images
        const accountImages = {};
        if (imagesResult.success && imagesResult.data) {
            imagesResult.data.forEach(row => {
                accountImages[row.CUST_AC_NO] = {
                    profile_image: row.PROFILE_IMAGE ? 
                        `data:image/jpeg;base64,${row.PROFILE_IMAGE}` : null,
                    sign_image: row.SIGN_IMAGE ? 
                        `data:image/jpeg;base64,${row.SIGN_IMAGE}` : null
                };
            });
        }

        // Add images to transactions and sort by request_date
        const finalTransactions = transformedTransactions
            .map(transaction => ({
                ...transaction,
                profile_image: accountImages[transaction.account_number]?.profile_image || null,
                sign_image: accountImages[transaction.account_number]?.sign_image || null
            }))
            .sort((a, b) => new Date(b.request_date) - new Date(a.request_date));

        // Calculate summary
        const summary = {
            total: finalTransactions.length,
            byType: {
                deposits: deposits.length,
                withdraws: withdraws.length,
                transfers: transfers.length,
                otherBankTransfers: otherBankTransfers.length,
                airTicketPayments: airTicketPayments.length
            },
            byStatus: finalTransactions.reduce((acc, curr) => {
                acc[curr.status] = (acc[curr.status] || 0) + 1;
                return acc;
            }, {})
        };


        var available_user = await getActiveTellerforTheBranch(user.branch);

        const availableUsers = available_user.map(user => user.user);

        res.status(200).json({
            error: false,
            data: {
                transactions: finalTransactions,
                availableUsers,
                summary
            }
        });

    } catch(e) {
        console.error("[GET_BRANCH_TRANSACTIONS] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not retrieve transactions"
        });
    }
});














// 1. Deposit Endpoint

router.post("/deposit", async(req, res, next) => {
    try {
        // Encrypted payload is REQUIRED — reject plaintext requests
        let body = req.body;
        if (!body.encrypted || typeof body.encrypted !== 'string') {
            return res.status(400).json({ error: true, message: "Encrypted payload is required" });
        }
        try {
            body = decryptPayload(body.encrypted);
        } catch (decErr) {
            return res.status(400).json({ error: true, message: "Invalid or tampered request payload" });
        }

        // Validate session token if provided (prevents unauthorized transactions)
        const sessionValid = await validateTransactionSession(body, res);
        if (!sessionValid) return;

        const {
            acc_holder_name,
            amount_in_words,
            amount_in_figures,
            source_of_funds,
            signature,
            account_number,
            deposited_by,
            depositor_address,
            account_type,
            system,
            branch
        } = body;

        // Generate unique Customer_Unique_Number server-side (ignore client value)
        const Customer_Unique_Number = await generateUniqueCustomerNumber();

        // Server-side input validation
        const amount = parseFloat(amount_in_figures);
        if (!amount_in_figures || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: true, message: "Invalid amount" });
        }
        if (!account_number || !/^\d{16}$/.test(account_number.toString().trim())) {
            return res.status(400).json({ error: true, message: "Invalid account number format" });
        }

        let correctedAccountType;
        switch(account_type.toLowerCase()) {
            case 'savings':
                correctedAccountType = 'Saving Account';
                break;
            case 'current':
                correctedAccountType = 'Demand/ Current Deposit Account';
                break;
            case 'special':
                correctedAccountType = 'Special Demand Deposit Account';
                break;
            default:
                correctedAccountType = 'Saving Account';
        }

        let depositData = {
            acc_holder_name,
            amount_in_words,
            amount_in_figures,
            source_of_funds,
            signature,
            account_number,
            deposited_by,
            depositor_address: {
                city: depositor_address?.CITY?.toLowerCase() || '',
                subcity: depositor_address?.SUBCITY?.toLowerCase() || '',
                woreda: depositor_address?.WOREDA?.toLowerCase() || '',
                house_number: depositor_address?.HOUSE_NUMBER || '',
                telephone: depositor_address?.TELEPHONE || ''
            },
            account_type: correctedAccountType,
            Customer_Unique_Number,
            status: 'requested'
        };

        if (system) {
            try {
                const assignmentDetails = await assignTellerBySystem(branch);
                depositData = {
                    ...depositData,
                    ...assignmentDetails
                };
            } catch (assignError) {
                console.error("[AUTO_ASSIGNMENT] Failed:", assignError.message);
                return res.status(400).json({
                    error: true,
                    message: "Could not auto-assign teller: " + assignError.message
                });
            }
        }

        const newDeposit = new Deposit(depositData);
        await newDeposit.save();
        
        const customerNumber = newDeposit.account_number.substring(6, 13);

 const phoneQuery = `
            SELECT MOBILE_NUMBER as telephone 
            FROM FCUBSPRD.sttm_cust_personal 
            WHERE CUSTOMER_NO = :1
        `;
        const phoneResult = await executeQuery(phoneQuery, [customerNumber]);
        if (phoneResult.success && phoneResult.data?.length > 0) {
            let phoneNumber = phoneResult.data[0].TELEPHONE;


            // Format phone number if needed (remove +, ensure 251 prefix)
            phoneNumber = phoneNumber.replace('+', '').replace(/^0/, '251');


            // Construct SMS content based on assignment status
            let smsContent = `Dear ${newDeposit.acc_holder_name},\n\nYour unique code is **${newDeposit.Customer_Unique_Number}**.\n\n`;
            
            if (newDeposit.assigned_to) {
                smsContent += `Please visit Teller **${newDeposit.assigned_to}** for assistance. `;
            } else {
                smsContent += `Feel free to receive service from any branch any teller at your convenience. `;
            }
            
            smsContent += `\n\nThank you for choosing Smart Branch! We appreciate your business.`;

            // URL encode the SMS content
            const encodedContent = encodeURIComponent(smsContent);

            // Construct SMS API URL
            const smsUrl = `https://smsgateway.zemenbank.com/http-api/send?username=smartbranch&password=Y8z6pTB80l6%234siD&to=${phoneNumber}&from=8011&coding=8&content=${encodedContent}`;

            try {
                // Send SMS using fetch or axios
                const response = await fetch(smsUrl);
                
                if (!response.ok) {
                    console.error("[SMS] Sending failed");
                }
            } catch (smsError) {
                console.error("[SMS] Sending error:", smsError.message);
                // Don't return error to client, just log it
            }
        }



        res.status(201).json({ 
            error: false, 
            message: "Deposit request created successfully",
            data: {
                Queue_number: newDeposit.Queue_number,
                request_date: newDeposit.request_date,
                status: newDeposit.status,
                assigned_to: newDeposit.assigned_to
            }
        });

    } catch(e) {
        console.error("[DEPOSIT] Error:", e.message);
        res.status(400).json({
            error: true,
            message: "Could not perform the operation"
        });
    }
});

// 2. Withdraw Endpoint
router.post("/withdraw", async(req, res, next) => {
    try {
        // Encrypted payload is REQUIRED — reject plaintext requests
        let body = req.body;
        if (!body.encrypted || typeof body.encrypted !== 'string') {
            return res.status(400).json({ error: true, message: "Encrypted payload is required" });
        }
        try {
            body = decryptPayload(body.encrypted);
            console.log('[Withdraw] Payload decrypted successfully');
        } catch (decErr) {
            console.error('[Withdraw] Decryption failed:', decErr.message);
            return res.status(400).json({ error: true, message: "Invalid or tampered request payload" });
        }

        // Validate session token if provided (prevents unauthorized transactions)
        const sessionValid = await validateTransactionSession(body, res);
        if (!sessionValid) return;

        delete body.reference_number;
        const {
            acc_holder_name,
            amount_in_words,
            amount_in_figures,
            source_of_funds,
            signature,
            account_number,
            deposited_by,
            depositor_address,
            account_type,
            system,
            branch
        } = body;

        // Generate unique Customer_Unique_Number server-side (ignore client value)
        const Customer_Unique_Number = await generateUniqueCustomerNumber();

        // Server-side input validation
        const amount = parseFloat(amount_in_figures);
        if (!amount_in_figures || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: true, message: "Invalid amount" });
        }
        if (!account_number || !/^\d{16}$/.test(account_number.toString().trim())) {
            return res.status(400).json({ error: true, message: "Invalid account number format" });
        }

        // Server-side withdrawal limit check
        try {
            const limitCheck = await FlexcubeTransactionService.checkWithdrawalLimit(account_number, amount);
            if (!limitCheck.allowed) {
                return res.status(400).json({
                    error: true,
                    message: limitCheck.reason || "Withdrawal exceeds allowed limit"
                });
            }
        } catch (limitError) {
            console.error("[WITHDRAW] Limit check error:", limitError.message);
            return res.status(400).json({
                error: true,
                message: "Unable to verify withdrawal limit. Please try again."
            });
        }

        // Server-side balance check — reject if amount exceeds available balance
        const balanceCheck = await getAccountBalance(account_number);
        if (balanceCheck.success && amount > balanceCheck.balance) {
            return res.status(400).json({
                error: true,
                message: "Insufficient balance. The requested amount exceeds your available balance."
            });
        }
        if (!balanceCheck.success) {
            return res.status(400).json({
                error: true,
                message: "Unable to verify account balance. Please try again."
            });
        }

        let correctedAccountType;
        switch(account_type.toLowerCase()) {
            case 'savings':
                correctedAccountType = 'Saving Account';
                break;
            case 'current':
                correctedAccountType = 'Demand/ Current Deposit Account';
                break;
            case 'special':
                correctedAccountType = 'Special Demand Deposit Account';
                break;
            default:
                correctedAccountType = 'Saving Account';
        }

        let withdrawData = {
            acc_holder_name,
            amount_in_words,
            amount_in_figures,
            source_of_funds,
            signature,
            account_number,
            deposited_by,
            depositor_address: {
                city: depositor_address?.CITY?.toLowerCase() || '',
                subcity: depositor_address?.SUBCITY?.toLowerCase() || '',
                woreda: depositor_address?.WOREDA?.toLowerCase() || '',
                house_number: depositor_address?.HOUSE_NUMBER || '',
                telephone: depositor_address?.TELEPHONE || ''
            },
            account_type: correctedAccountType,
            Customer_Unique_Number,
            request_date: new Date().toISOString(),
            status: 'requested'
        };

        if (system) {
            try {
                const assignmentDetails = await assignTellerBySystem(branch);
                withdrawData = {
                    ...withdrawData,
                    ...assignmentDetails
                };
            } catch (assignError) {
                console.error("[AUTO_ASSIGNMENT] Failed:", assignError.message);
                return res.status(400).json({
                    error: true,
                    message: "Could not auto-assign teller: " + assignError.message
                });
            }
        }

        const newWithdraw = new Withdraw(withdrawData);
        await newWithdraw.save();



        const customerNumber = newWithdraw.account_number.substring(6, 13);

 const phoneQuery = `
            SELECT MOBILE_NUMBER as telephone
            FROM FCUBSPRD.sttm_cust_personal
            WHERE CUSTOMER_NO = :1
        `;
        const phoneResult = await executeQuery(phoneQuery, [customerNumber]);
        if (phoneResult.success && phoneResult.data?.length > 0) {
            let phoneNumber = phoneResult.data[0].TELEPHONE;


            // Format phone number if needed (remove +, ensure 251 prefix)
            phoneNumber = phoneNumber.replace('+', '').replace(/^0/, '251');


            // Construct SMS content based on assignment status
            let smsContent = `Dear ${newWithdraw.acc_holder_name}.\n\nYour unique code is **${newWithdraw.Customer_Unique_Number}**.\n\n`;
            
            if (newWithdraw.assigned_to) {
                smsContent += `Please visit Teller **${newWithdraw.assigned_to}** for assistance. `;
            } else {
                smsContent += `Feel free to receive service from any teller at your convenience. `;
            }
            
            smsContent += `\n\nThank you for choosing Smart Branch! We appreciate your business.`;

            // URL encode the SMS content
            const encodedContent = encodeURIComponent(smsContent);

            // Construct SMS API URL
            const smsUrl = `https://smsgateway.zemenbank.com/http-api/send?username=smartbranch&password=Y8z6pTB80l6%234siD&to=${phoneNumber}&from=8011&coding=8&content=${encodedContent}`;

            try {
                // Send SMS using fetch or axios
                const response = await fetch(smsUrl);
                
                if (!response.ok) {
                    console.error("[SMS] Sending failed");
                }
            } catch (smsError) {
                console.error("[SMS] Sending error:", smsError.message);
                // Don't return error to client, just log it
            }
        }



        res.status(201).json({ 
            error: false, 
            message: "Withdraw request created successfully",
            data: {
                Queue_number: newWithdraw.Queue_number,
                request_date: newWithdraw.request_date,
                status: newWithdraw.status,
                assigned_to: newWithdraw.assigned_to
            }
        });

    } catch(e) {
        console.error("[WITHDRAW] Error:", e.message);
        res.status(400).json({
            error: true,
            message: "Could not perform the operation"
        });
    }
});

// E-Check Endpoint (same as withdraw + recipient information)
router.post("/echeck", async(req, res, next) => {
    try {
        // Encrypted payload is REQUIRED — reject plaintext requests
        let body = req.body;
        if (!body.encrypted || typeof body.encrypted !== 'string') {
            return res.status(400).json({ error: true, message: "Encrypted payload is required" });
        }
        try {
            body = decryptPayload(body.encrypted);
        } catch (decErr) {
            return res.status(400).json({ error: true, message: "Invalid or tampered request payload" });
        }

        // Validate session token if provided (prevents unauthorized transactions)
        const sessionValid = await validateTransactionSession(body, res);
        if (!sessionValid) return;

        delete body.reference_number;
        const {
            acc_holder_name,
            recipient_full_name,
            recipient_phone_number,
            amount_in_words,
            amount_in_figures,
            source_of_funds,
            signature,
            account_number,
            deposited_by,
            depositor_address,
            account_type,
            system,
            branch
        } = body;

        // Generate unique Customer_Unique_Number server-side (ignore client value)
        const Customer_Unique_Number = await generateUniqueCustomerNumber();

        // Validate recipient information
        if (!recipient_full_name || !recipient_phone_number) {
            return res.status(400).json({
                error: true,
                message: "Recipient full name and phone number are required for E-Check"
            });
        }

        // Server-side input validation
        const amount = parseFloat(amount_in_figures);
        if (!amount_in_figures || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: true, message: "Invalid amount" });
        }
        if (!account_number || !/^\d{16}$/.test(account_number.toString().trim())) {
            return res.status(400).json({ error: true, message: "Invalid account number format" });
        }

        // Server-side balance check
        const balanceCheck = await getAccountBalance(account_number);
        if (balanceCheck.success && amount > balanceCheck.balance) {
            return res.status(400).json({
                error: true,
                message: "Insufficient balance. The requested amount exceeds your available balance."
            });
        }
        if (!balanceCheck.success) {
            return res.status(400).json({
                error: true,
                message: "Unable to verify account balance. Please try again."
            });
        }

        // Server-side daily withdrawal limit check
        try {
            const limitCheck = await FlexcubeTransactionService.checkWithdrawalLimit(account_number, amount);
            if (!limitCheck.allowed) {
                return res.status(400).json({
                    error: true,
                    message: limitCheck.reason || "E-Check exceeds daily withdrawal limit"
                });
            }
        } catch (limitError) {
            console.error("[ECHECK] Limit check error:", limitError.message);
            return res.status(400).json({
                error: true,
                message: "Unable to verify withdrawal limit. Please try again."
            });
        }

        let correctedAccountType;
        switch(account_type.toLowerCase()) {
            case 'savings':
                correctedAccountType = 'Saving Account';
                break;
            case 'current':
                correctedAccountType = 'Demand/ Current Deposit Account';
                break;
            case 'special':
                correctedAccountType = 'Special Demand Deposit Account';
                break;
            default:
                correctedAccountType = 'Saving Account';
        }

        let eCheckData = {
            acc_holder_name,
            recipient_full_name,
            recipient_phone_number,
            amount_in_words,
            amount_in_figures,
            source_of_funds,
            signature,
            account_number,
            deposited_by,
            depositor_address: {
                city: depositor_address?.CITY?.toLowerCase() || '',
                subcity: depositor_address?.SUBCITY?.toLowerCase() || '',
                woreda: depositor_address?.WOREDA?.toLowerCase() || '',
                house_number: depositor_address?.HOUSE_NUMBER || '',
                telephone: depositor_address?.TELEPHONE || ''
            },
            account_type: correctedAccountType,
            Customer_Unique_Number,
            request_date: new Date().toISOString(),
            status: 'requested'
        };

        if (system) {
            try {
                const assignmentDetails = await assignTellerBySystem(branch);
                eCheckData = {
                    ...eCheckData,
                    ...assignmentDetails
                };
            } catch (assignError) {
                console.error("[AUTO_ASSIGNMENT] Failed:", assignError.message);
                return res.status(400).json({
                    error: true,
                    message: "Could not auto-assign teller: " + assignError.message
                });
            }
        }

        const newECheck = new ECheck(eCheckData);
        await newECheck.save();

        const customerNumber = newECheck.account_number.substring(6, 13);

        const phoneQuery = `
            SELECT MOBILE_NUMBER as telephone
            FROM FCUBSPRD.sttm_cust_personal
            WHERE CUSTOMER_NO = :1
        `;
        const phoneResult = await executeQuery(phoneQuery, [customerNumber]);
        if (phoneResult.success && phoneResult.data?.length > 0) {
            let phoneNumber = phoneResult.data[0].TELEPHONE;

            // Format phone number if needed (remove +, ensure 251 prefix)
            phoneNumber = phoneNumber.replace('+', '').replace(/^0/, '251');

            // Construct SMS content based on assignment status
            let smsContent = `Dear ${newECheck.acc_holder_name}.\n\nYour E-Check unique code is **${newECheck.Customer_Unique_Number}**.\n\n`;
            smsContent += `Recipient: ${newECheck.recipient_full_name} (${newECheck.recipient_phone_number})\n\n`;

            if (newECheck.assigned_to) {
                smsContent += `Please visit Teller **${newECheck.assigned_to}** for assistance. `;
            } else {
                smsContent += `Feel free to receive service from any teller at your convenience. `;
            }

            smsContent += `\n\nThank you for choosing Smart Branch! We appreciate your business.`;

            // URL encode the SMS content
            const encodedContent = encodeURIComponent(smsContent);

            // Construct SMS API URL
            const smsUrl = `https://smsgateway.zemenbank.com/http-api/send?username=smartbranch&password=Y8z6pTB80l6%234siD&to=${phoneNumber}&from=8011&coding=8&content=${encodedContent}`;

            try {
                // Send SMS using fetch or axios
                const response = await fetch(smsUrl);

                if (!response.ok) {
                    console.error("[SMS] Sending failed");
                }
            } catch (smsError) {
                console.error("[SMS] Sending error:", smsError.message);
                // Don't return error to client, just log it
            }
        }

        res.status(201).json({
            error: false,
            message: "E-Check request created successfully",
            data: {
                Queue_number: newECheck.Queue_number,
                Customer_Unique_Number: newECheck.Customer_Unique_Number,
                request_date: newECheck.request_date,
                status: newECheck.status,
                assigned_to: newECheck.assigned_to,
                recipient_full_name: newECheck.recipient_full_name,
                recipient_phone_number: newECheck.recipient_phone_number
            }
        });

    } catch(e) {
        console.error("[ECHECK] Error:", e.message);
        res.status(400).json({
            error: true,
            message: "Could not perform the operation"
        });
    }
});

// 3. Transfer Endpoint
router.post("/transfer", async(req, res, next) => {
    try {
        // Encrypted payload is REQUIRED — reject plaintext requests
        let body = req.body;
        if (!body.encrypted || typeof body.encrypted !== 'string') {
            return res.status(400).json({ error: true, message: "Encrypted payload is required" });
        }
        try {
            body = decryptPayload(body.encrypted);
        } catch (decErr) {
            return res.status(400).json({ error: true, message: "Invalid or tampered request payload" });
        }

        // Validate session token if provided (prevents unauthorized transactions)
        const sessionValid = await validateTransactionSession(body, res);
        if (!sessionValid) return;

        body.payment_narration = body.payment_narrative;
        delete body.payment_narrative;
        const {
            acc_holder_name,
            amount_in_words,
            amount_in_figures,
            source_of_funds,
            signature,
            account_number,
            beneficiary_account_number,
            beneficiary_branch,
            beneficiary_name,
            payment_narration,
            account_type,
            system,
            branch
        } = body;

        // Generate unique Customer_Unique_Number server-side (ignore client value)
        const Customer_Unique_Number = await generateUniqueCustomerNumber();

        // Server-side input validation
        const amount = parseFloat(amount_in_figures);
        if (!amount_in_figures || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: true, message: "Invalid amount" });
        }
        if (!account_number || !/^\d{16}$/.test(account_number.toString().trim())) {
            return res.status(400).json({ error: true, message: "Invalid account number format" });
        }
        if (!beneficiary_account_number || !/^\d{16}$/.test(beneficiary_account_number.toString().trim())) {
            return res.status(400).json({ error: true, message: "Invalid beneficiary account number format" });
        }

        // Server-side balance check
        const balanceCheck = await getAccountBalance(account_number);
        if (balanceCheck.success && amount > balanceCheck.balance) {
            return res.status(400).json({
                error: true,
                message: "Insufficient balance. The requested amount exceeds your available balance."
            });
        }
        if (!balanceCheck.success) {
            return res.status(400).json({
                error: true,
                message: "Unable to verify account balance. Please try again."
            });
        }

        // Server-side daily withdrawal limit check
        try {
            const limitCheck = await FlexcubeTransactionService.checkWithdrawalLimit(account_number, amount);
            if (!limitCheck.allowed) {
                return res.status(400).json({
                    error: true,
                    message: limitCheck.reason || "Transfer exceeds daily withdrawal limit"
                });
            }
        } catch (limitError) {
            console.error("[TRANSFER] Limit check error:", limitError.message);
            return res.status(400).json({
                error: true,
                message: "Unable to verify withdrawal limit. Please try again."
            });
        }

        let correctedAccountType;
        switch(account_type.toLowerCase()) {
            case 'savings':
                correctedAccountType = 'Saving Account';
                break;
            case 'current':
                correctedAccountType = 'Demand/ Current Deposit Account';
                break;
            case 'special':
                correctedAccountType = 'Special Demand Deposit Account';
                break;
            default:
                correctedAccountType = 'Saving Account';
        }

        let transferData = {
            acc_holder_name,
            amount_in_words,
            amount_in_figures,
            source_of_funds,
            signature,
            account_number,
            beneficiary_account_number,
            beneficiary_branch,
            beneficiary_name,
            payment_narration,
            account_type: correctedAccountType,
            Customer_Unique_Number,
            request_type: 'Transfer',
            status: 'requested'
        };

        if (system) {
            try {
                const assignmentDetails = await assignTellerBySystem(branch);
                transferData = {
                    ...transferData,
                    ...assignmentDetails
                };
            } catch (assignError) {
                console.error("[AUTO_ASSIGNMENT] Failed:", assignError.message);
                return res.status(400).json({
                    error: true,
                    message: "Could not auto-assign teller: " + assignError.message
                });
            }
        }

        const newTransfer = new Transfer(transferData);
        await newTransfer.save();



        
        const customerNumber = newTransfer.account_number.substring(6, 13);

 const phoneQuery = `
            SELECT MOBILE_NUMBER as telephone
            FROM FCUBSPRD.sttm_cust_personal
            WHERE CUSTOMER_NO = :1
        `;
        const phoneResult = await executeQuery(phoneQuery, [customerNumber]);
        if (phoneResult.success && phoneResult.data?.length > 0) {
            let phoneNumber = phoneResult.data[0].TELEPHONE;


            // Format phone number if needed (remove +, ensure 251 prefix)
            phoneNumber = phoneNumber.replace('+', '').replace(/^0/, '251');
            

            // Construct SMS content based on assignment status
            let smsContent = `Dear  ${newTransfer.acc_holder_name},\n\nYour unique code is **${newTransfer.Customer_Unique_Number}**.\n\n`;
            
            if (newTransfer.assigned_to) {
                smsContent += `Please visit Teller **${newTransfer.assigned_to}** for assistance. `;
            } else {
                smsContent += `Feel free to receive service from any branch any teller at your convenience. `;
            }
            
            smsContent += `\n\nThank you for choosing Smart Branch! We appreciate your business.`;

            // URL encode the SMS content
            const encodedContent = encodeURIComponent(smsContent);

            // Construct SMS API URL
            const smsUrl = `https://smsgateway.zemenbank.com/http-api/send?username=smartbranch&password=Y8z6pTB80l6%234siD&to=${phoneNumber}&from=8011&coding=8&content=${encodedContent}`;

            try {
                // Send SMS using fetch or axios
                const response = await fetch(smsUrl);
                
                if (!response.ok) {
                    console.error("[SMS] Sending failed");
                }
            } catch (smsError) {
                console.error("[SMS] Sending error:", smsError.message);
                // Don't return error to client, just log it
            }
        }




        res.status(201).json({ 
            error: false, 
            message: "Transfer request created successfully",
            data: {
                Queue_number: newTransfer.Queue_number,
                request_date: newTransfer.request_date,
                status: newTransfer.status,
                assigned_to: newTransfer.assigned_to
            }
        });

    } catch(e) {
        console.error("[TRANSFER] Error:", e.message);
        res.status(400).json({
            error: true,
            message: "Could not perform the operation"
        });
    }
});


// 4. Other Bank Transfer Endpoint
router.post("/other_bank_transfer", async(req, res, next) => {
    try {
        // Encrypted payload is REQUIRED — reject plaintext requests
        let body = req.body;
        if (!body.encrypted || typeof body.encrypted !== 'string') {
            return res.status(400).json({ error: true, message: "Encrypted payload is required" });
        }
        try {
            body = decryptPayload(body.encrypted);
        } catch (decErr) {
            return res.status(400).json({ error: true, message: "Invalid or tampered request payload" });
        }

        // Validate session token if provided (prevents unauthorized transactions)
        const sessionValid = await validateTransactionSession(body, res);
        if (!sessionValid) return;

        const {
            acc_holder_name,
            amount_in_words,
            amount_in_figures,
            acc_holder_branch,
            address,
            telephone,
            transfer_type,
            beneficiary_bank,
            signature,
            account_number,
            beneficiary_account_number,
            beneficiary_branch,
            beneficiary_name,
            account_type,
            system,
            branch
        } = body;

        // Generate unique Customer_Unique_Number server-side (ignore client value)
        const Customer_Unique_Number = await generateUniqueCustomerNumber();

        // Server-side balance check
        const amount = parseFloat(amount_in_figures);
        if (!amount_in_figures || isNaN(amount) || amount <= 0) {
            return res.status(400).json({ error: true, message: "Invalid amount" });
        }
        if (!account_number || !/^\d{16}$/.test(account_number.toString().trim())) {
            return res.status(400).json({ error: true, message: "Invalid account number format" });
        }
        const balanceCheck = await getAccountBalance(account_number);
        if (balanceCheck.success && amount > balanceCheck.balance) {
            return res.status(400).json({
                error: true,
                message: "Insufficient balance. The requested amount exceeds your available balance."
            });
        }
        if (!balanceCheck.success) {
            return res.status(400).json({
                error: true,
                message: "Unable to verify account balance. Please try again."
            });
        }

        // Server-side daily withdrawal limit check
        try {
            const limitCheck = await FlexcubeTransactionService.checkWithdrawalLimit(account_number, amount);
            if (!limitCheck.allowed) {
                return res.status(400).json({
                    error: true,
                    message: limitCheck.reason || "Transfer exceeds daily withdrawal limit"
                });
            }
        } catch (limitError) {
            console.error("[OTHER_BANK_TRANSFER] Limit check error:", limitError.message);
            return res.status(400).json({
                error: true,
                message: "Unable to verify withdrawal limit. Please try again."
            });
        }

        let correctedAccountType;
        switch(account_type.toLowerCase()) {
            case 'savings':
                correctedAccountType = 'Saving Account';
                break;
            case 'current':
                correctedAccountType = 'Demand/ Current Deposit Account';
                break;
            case 'special':
                correctedAccountType = 'Special Demand Deposit Account';
                break;
            default:
                correctedAccountType = 'Saving Account';
        }

        let transferData = {
            acc_holder_name,
            amount_in_words,
            amount_in_figures,
            beneficiary_bank,
            signature,
            account_number,
            acc_holder_branch,
            address,
            telephone,
            transfer_type,
            beneficiary_account_number,
            beneficiary_branch,
            beneficiary_name,
            account_type: correctedAccountType,
            Customer_Unique_Number,
            status: 'requested'
        };

        if (system) {
            try {
                const assignmentDetails = await assignTellerBySystem(branch);
                transferData = {
                    ...transferData,
                    ...assignmentDetails
                };
            } catch (assignError) {
                console.error("[AUTO_ASSIGNMENT] Failed:", assignError.message);
                return res.status(400).json({
                    error: true,
                    message: "Could not auto-assign teller: " + assignError.message
                });
            }
        }

        const newOtherBankTransfer = new Other_Bank_Transfer(transferData);
        await newOtherBankTransfer.save();


        const customerNumber = newOtherBankTransfer.account_number.substring(6, 13);

 const phoneQuery = `
            SELECT MOBILE_NUMBER as telephone
            FROM FCUBSPRD.sttm_cust_personal
            WHERE CUSTOMER_NO = :1
        `;
        const phoneResult = await executeQuery(phoneQuery, [customerNumber]);
        if (phoneResult.success && phoneResult.data?.length > 0) {
            let phoneNumber = phoneResult.data[0].TELEPHONE;


            // Format phone number if needed (remove +, ensure 251 prefix)
            phoneNumber = phoneNumber.replace('+', '').replace(/^0/, '251');
            

            // Construct SMS content based on assignment status
            let smsContent = `Dear Customer, ${newOtherBankTransfer.acc_holder_name}.\n\nYour unique code is **${newOtherBankTransfer.Customer_Unique_Number}**.\n\n`;
            
            if (newOtherBankTransfer.assigned_to) {
                smsContent += `Please visit Teller **${newOtherBankTransfer.assigned_to}** for assistance. `;
            } else {
                smsContent += `Feel free to receive service from any teller at your convenience. `;
            }
            
            smsContent += `\n\nThank you for choosing Smart Branch! We appreciate your business.`;

            // URL encode the SMS content
            const encodedContent = encodeURIComponent(smsContent);

            // Construct SMS API URL
            const smsUrl = `https://smsgateway.zemenbank.com/http-api/send?username=smartbranch&password=Y8z6pTB80l6%234siD&to=${phoneNumber}&from=8011&coding=8&content=${encodedContent}`;

            try {
                // Send SMS using fetch or axios
                const response = await fetch(smsUrl);
                
                if (!response.ok) {
                    console.error("[SMS] Sending failed");
                }
            } catch (smsError) {
                console.error("[SMS] Sending error:", smsError.message);
                // Don't return error to client, just log it
            }
        }
        

        res.status(201).json({ 
            error: false, 
            message: "Other Bank Transfer request created successfully",
            data: {
                Queue_number: newOtherBankTransfer.Queue_number,
                request_date: newOtherBankTransfer.request_date,
                status: newOtherBankTransfer.status,
                assigned_to: newOtherBankTransfer.assigned_to
            }
        });

    } catch(e) {
        console.error("[OTHER_BANK_TRANSFER] Error:", e.message);
        res.status(400).json({
            error: true,
            message: "Could not perform the operation"
        });
    }
});






router.get("/transactions", auth, roleCheck(["Teller", "Authorizer", "Maker", "Admin"]), async (req, res) => {
    try {
        const { query } = req.query;

        if (!query) {
            return res.status(400).json({
                error: true,
                message: "Please provide a query parameter"
            });
        }

        // Get today's date at midnight
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        let searchQuery;

        // Check the user's role
        if (req.user.roles.includes('Admin')) {
            // Admin can search by account_number, Customer_Unique_Number, or acc_holder_name
            // Escape the name search so a crafted query can't inject a regex /
            // trigger ReDoS on the hot path (same case-insensitive substring match).
            const safeName = String(query).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            searchQuery = {
                $or: [
                    { account_number: query },
                    { Customer_Unique_Number: query },
                    { acc_holder_name: new RegExp(safeName, 'i') }
                ],
                request_date: {
                    $gte: today,
                    $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
                }
            };
        } else if (req.user.roles.includes('Teller') || req.user.roles.includes('Maker')) {
            // Teller and Makers can only search by Customer_Unique_Number
            searchQuery = {
                Customer_Unique_Number: query,
                request_date: {
                    $gte: today,
                    $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
                }
            };
        } else {
            return res.status(403).json({
                error: true,
                message: "You do not have permission to access this resource"
            });
        }

        // Fetch from all collections IN PARALLEL with .lean() (read-only).
        // The query is index-backed: {Customer_Unique_Number,request_date} for
        // tellers, {account_number,request_date} + the date window for admins.
        //
        // IMPORTANT (scalability): the per-search Oracle/Flexcube image lookup
        // was REMOVED from this hot path. It meant a Flexcube round-trip + base64
        // transfer on EVERY search, which cannot survive teller-fleet traffic
        // (thousands of searches/sec). The result table never showed those
        // images anyway — profile_image/sign_image are fetched ON DEMAND only
        // when a teller opens a result's detail (GET /account_images/:account).
        const [deposits, withdraws, echecks, transfers, otherBankTransfers, airTicketPayments] = await Promise.all([
            Deposit.find(searchQuery).lean(),
            Withdraw.find(searchQuery).lean(),
            ECheck.find(searchQuery).lean(),
            Transfer.find(searchQuery).lean(),
            Other_Bank_Transfer.find(searchQuery).lean(),
            Air_Ticket_Payment.find(searchQuery).lean(),
        ]);

        // Combine (preserve the original merge order).
        const transactions = [
            ...withdraws,
            ...echecks,
            ...deposits,
            ...transfers,
            ...otherBankTransfers,
            ...airTicketPayments,
        ];

        res.status(200).json({
            error: false,
            transactions
        });

    } catch (e) {
        console.error("[TRANSACTIONS] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not retrieve transactions"
        });
    }
});

// On-demand customer images for a single account. Called only when a teller
// OPENS a search result's details — NOT on every search — so the expensive
// Flexcube/Oracle image lookup stays off the high-TPS search path.
router.get("/account_images/:account_number", auth, roleCheck(["Teller", "Authorizer", "Maker", "Admin"]), async (req, res) => {
    try {
        const { account_number } = req.params;
        if (!account_number) {
            return res.status(400).json({ error: true, message: "account_number is required" });
        }

        const imagesQuery = `
            SELECT
                CA.CUST_AC_NO,
                CI.IMAGE_TEXT AS PROFILE_IMAGE,
                SI.SIG_TEXT AS SIGN_IMAGE
            FROM fcubsprd.STTM_CUST_ACCOUNT CA
            LEFT JOIN fcubsprd.STTM_CUST_IMAGE CI ON CA.CUST_NO = CI.CUSTOMER_NO
            LEFT JOIN fcubsprd.svtm_cif_sig_det SI ON CA.CUST_NO = SI.CIF_ID
            WHERE CA.CUST_AC_NO = :1
        `;
        const result = await executeQuery(imagesQuery, [account_number], {
            fetchInfo: {
                PROFILE_IMAGE: { type: oracledb.STRING },
                SIGN_IMAGE: { type: oracledb.STRING },
            },
        });

        let profile_image = null;
        let sign_image = null;
        if (result.success && result.data && result.data.length > 0) {
            const row = result.data[0];
            profile_image = row.PROFILE_IMAGE ? `data:image/jpeg;base64,${row.PROFILE_IMAGE}` : null;
            sign_image = row.SIGN_IMAGE ? `data:image/jpeg;base64,${row.SIGN_IMAGE}` : null;
        }

        res.status(200).json({ error: false, data: { profile_image, sign_image } });
    } catch (e) {
        console.error("[ACCOUNT_IMAGES] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not retrieve account images" });
    }
});








// router.get("/transactions", auth, roleCheck(["Teller"]), async (req, res) => {
//     try {
//         const { query } = req.query;

//         if (!query) {
//             return res.status(400).json({
//                 error: true,
//                 message: "Please provide a query parameter"
//             });
//         }

//         // Get today's date at midnight
//         const today = new Date();
//         today.setHours(0, 0, 0, 0);

//         // Build query to check account_number, Customer_Unique_Number, or acc_holder_name
//         const searchQuery = {
//             $or: [
//                 { account_number: query },
//                 { Customer_Unique_Number: query },
//                 { acc_holder_name: new RegExp(query, 'i') }
//             ],
//             request_date: {
//                 $gte: today,
//                 $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
//             }
//         };

//         // Fetch data from all models
//         const deposits = await Deposit.find(searchQuery);
//         const withdraws = await Withdraw.find(searchQuery);
//         const transfers = await Transfer.find(searchQuery);
//         const otherBankTransfers = await Other_Bank_Transfer.find(searchQuery);
//         const airTicketPayments = await Air_Ticket_Payment.find(searchQuery);

//         // Combine all transactions
//         let transactions = [
//             ...withdraws,
//             ...deposits,
//             ...transfers,
//             ...otherBankTransfers,
//             ...airTicketPayments
//         ];

//         // Get unique account numbers from all transactions
//         const accountNumbers = [...new Set(transactions.map(t => t.account_number))];
      
        
//         // Fetch images for all account numbers in a single query
//         const imagesQuery = `
//             SELECT 
//                 CA.CUST_AC_NO,
//                 CI.IMAGE_TEXT AS PROFILE_IMAGE,
//                 SI.SIG_TEXT AS SIGN_IMAGE
//             FROM fcubsprd.STTM_CUST_ACCOUNT CA
//             LEFT JOIN fcubsprd.STTM_CUST_IMAGE CI ON CA.CUST_NO = CI.CUSTOMER_NO
//             LEFT JOIN fcubsprd.svtm_cif_sig_det SI ON CA.CUST_NO = SI.CIF_ID
//             WHERE CA.CUST_AC_NO IN (${accountNumbers.map((_, i) => `:${i + 1}`).join(',')})
//         `;

//         const imagesResult = await executeQuery(
//             imagesQuery,
//             accountNumbers,
//             {
//                 fetchInfo: {
//                     PROFILE_IMAGE: { type: oracledb.STRING },
//                     SIGN_IMAGE: { type: oracledb.STRING }
//                 }
//             }
//         );

//         // Create a map of account numbers to their images
//         const accountImages = {};
//         if (imagesResult.success && imagesResult.data) {
//             imagesResult.data.forEach(row => {
//                 accountImages[row.CUST_AC_NO] = {
//                     profile_image: row.PROFILE_IMAGE ? 
//                         `data:image/jpeg;base64,${row.PROFILE_IMAGE}` : null,
//                     sign_image: row.SIGN_IMAGE ? 
//                         `data:image/jpeg;base64,${row.SIGN_IMAGE}` : null
//                 };
//             });
//         }

//         // Add images to transactions
//         transactions = transactions.map(transaction => ({
//             ...transaction.toObject(), // Convert mongoose document to plain object
//             profile_image: accountImages[transaction.account_number]?.profile_image || null,
//             sign_image: accountImages[transaction.account_number]?.sign_image || null
//         }));

//         res.status(200).json({
//             error: false,
//             transactions
//         });

//     } catch (e) {
//         console.log("Error", e);
//         res.status(500).json({
//             error: true,
//             message: e.message || "Could not retrieve transactions"
//         });
//     }
// });











router.post("/assigned_to_me", auth, roleCheck(["Teller", "Maker"]), async(req, res, next) => {
    try {

        // Get current user
        const user = await User.findById(req.user._id).lean();
        if (!user) {
            return res.status(400).json({ error: true, message: "Requester not found" });
        }

        const { transactions } = req.body;
        
        if (!transactions || !Array.isArray(transactions)) {
            return res.status(400).json({ 
                error: true, 
                message: "Transactions array is required" 
            });
        }

        const updateResults = {
            totalModified: 0,
            details: {},
            skipped: [] // Track skipped transactions
        };

        // Process each transaction type
        for (const transaction of transactions) {
            let Model;
            const type = transaction.transactionType.toLowerCase();

            // Determine the model based on transaction type
            switch(type) {
                case 'deposit':
                    Model = Deposit;
                    break;
                case 'withdraw':
                    Model = Withdraw;
                    break;
                case 'echeck':
                case 'e-check':  // Handle both old and new format
                    Model = ECheck;
                    break;
                case 'transfer':
                    Model = Transfer;
                    break;
                case 'other_bank_transfer':
                    Model = Other_Bank_Transfer;
                    break;
                case 'air_ticket_payment':
                    Model = Air_Ticket_Payment;
                    break;
                default:
                    updateResults.skipped.push({
                        id: transaction.id,
                        reason: "Invalid transaction type"
                    });
                    continue;
            }

            // Check transaction status first
            const existingTransaction = await Model.findOne({
                _id: transaction.id
            }).select('status');

            if (!existingTransaction) {
                updateResults.skipped.push({
                    id: transaction.id,
                    reason: "Transaction not found"
                });
                continue;
            }

            if (existingTransaction.status !== 'requested') {
                updateResults.skipped.push({
                    id: transaction.id,
                    reason: `Transaction status is ${existingTransaction.status}`
                });
                continue;
            }

            // Update transaction if status is 'requested'
            const updateResult = await Model.updateOne(
                {
                    _id: transaction.id,
                    status: 'requested'
                },
                {
                    $set: {
                        assigned_by: user.user,
                        branch: user.branch,
                        assigned_to: user.user,
                        assigned_date: new Date().toISOString(),
                        status: 'assigned'
                    }
                }
            );

            // Track successful updates
            if (updateResult.modifiedCount > 0) {
                updateResults.totalModified += 1;
                updateResults.details[type] = (updateResults.details[type] || 0) + 1;
            }
        }

        // Prepare response message
        const responseMessage = updateResults.totalModified > 0
            ? `Successfully assigned ${updateResults.totalModified} transactions${
                updateResults.skipped.length > 0 
                    ? `, skipped ${updateResults.skipped.length} transactions`
                    : ''
              }`
            : "No transactions were updated";

        res.status(200).json({
            error: false,
            message: responseMessage,
            data: {
                totalModified: updateResults.totalModified,
                detailsByType: updateResults.details,
                skippedTransactions: updateResults.skipped,
                assignedTo: user.name,
                assignedDate: new Date().toISOString()
            }
        });

    } catch(e) {
        console.error("[ASSIGNED_TO_ME] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not perform the operation"
        });
    }
});




router.post("/transaction_posted", auth, roleCheck(["Teller"]), async(req, res, next) => {
    try {
        // Get current user
        const user = await User.findById(req.user._id).lean();
        if (!user) {
            return res.status(400).json({ error: true, message: "Requester not found" });
        }

        const { transaction_id } = req.body;

        if (!transaction_id) {
            return res.status(400).json({
                error: true,
                message: "Transaction ID is required"
            });
        }

        // Auto-generate unique transaction reference number server-side
        const datePart = new Date().toISOString().slice(0, 10).replace(/-/g, '');
        const randomPart = crypto.randomBytes(3).toString('hex').toUpperCase();
        const trn_ref_no = `${user.branch || 'BR'}-${datePart}-${randomPart}`;

        // First find the transaction to get its type and details
        let transaction;
        let Model;
        let txnTrnCode;

        // Try to find in each model
        if (await Deposit.exists({ _id: transaction_id })) {
            Model = Deposit;
            transaction = await Deposit.findById(transaction_id);
            txnTrnCode = 'CDP';
        } else if (await Transfer.exists({ _id: transaction_id })) {
            Model = Transfer;
            transaction = await Transfer.findById(transaction_id);
            txnTrnCode = 'FTT';
        } else if (await Withdraw.exists({ _id: transaction_id })) {
            Model = Withdraw;
            transaction = await Withdraw.findById(transaction_id);
            txnTrnCode = 'CWL';
        } else if (await ECheck.exists({ _id: transaction_id })) {
            Model = ECheck;
            transaction = await ECheck.findById(transaction_id);
            txnTrnCode = 'CWL'; // E-Check uses same SOAP as withdraw
        } else if (await Other_Bank_Transfer.exists({ _id: transaction_id })) {
            Model = Other_Bank_Transfer;
            transaction = await Other_Bank_Transfer.findById(transaction_id);
            txnTrnCode = 'OFT';
        } else if (await Air_Ticket_Payment.exists({ _id: transaction_id })) {
            Model = Air_Ticket_Payment;
            transaction = await Air_Ticket_Payment.findById(transaction_id);
            txnTrnCode = 'EAP';
        } else {
            return res.status(404).json({
                error: true,
                message: "Transaction not found"
            });
        }

        // Verify transaction status and assignment
        if (transaction.status !== 'assigned') {
            return res.status(400).json({
                error: true,
                message: `Transaction status is ${transaction.status}, expected 'assigned'`
            });
        }

        if (transaction.assigned_to !== user.user) {
            return res.status(400).json({
                error: true,
                message: `Transaction is assigned to ${transaction.assigned_to}`
            });
        }

        // Format the assigned_date to match Flexcube format
        const formatDate = (date) => {
            const d = new Date(date);
            const month = (d.getMonth() + 1).toString().padStart(2, '0');
            const day = d.getDate().toString().padStart(2, '0');
            const year = d.getFullYear();
            const hours = d.getHours();
            const minutes = d.getMinutes().toString().padStart(2, '0');
            const seconds = d.getSeconds().toString().padStart(2, '0');
            const ampm = hours >= 12 ? 'PM' : 'AM';
            const formattedHours = (hours % 12 || 12).toString().padStart(2, '0');
            
            return `${month}/${day}/${year} ${formattedHours}:${minutes}:${seconds} ${ampm}`;
        };

        const formattedAssignedDate = formatDate(transaction.assigned_date);

        // Query Flexcube with formatted date
        const flexQuery = `
            SELECT TXN_TRN_CODE, TXN_ACC, TXN_AMOUNT, OFS_AMOUNT, OFS_ACC, 
                   MAKER_ID, MAKER_DT_STAMP, CHECKER_ID, CHECKER_DT_STAMP
            FROM fcubsprd.detb_rtl_teller 
            WHERE trn_ref_no = :1 
            AND MAKER_ID = :2 
            AND TXN_TRN_CODE = :3
        `;

        const flexResult = await executeQuery(flexQuery, [
            trn_ref_no,
            user.flex_id,
            txnTrnCode
        ]);


    //     const flexQuery = `
    //     SELECT TXN_TRN_CODE, TXN_ACC, TXN_AMOUNT, OFS_AMOUNT, OFS_ACC, 
    //            MAKER_ID, MAKER_DT_STAMP, CHECKER_ID, CHECKER_DT_STAMP
    //     FROM fcubsprd.detb_rtl_teller 
    //     WHERE trn_ref_no = :1 
    //     AND MAKER_ID = :2 
    //     AND MAKER_DT_STAMP > TO_DATE(:3, 'MM/DD/YYYY HH:MI:SS AM')
    //     AND TXN_TRN_CODE = :4
    // `;

    // const flexResult = await executeQuery(flexQuery, [
    //     trn_ref_no,
    //     user.flex_id,
    //     formattedAssignedDate,
    //     txnTrnCode
    // ]);


        if (!flexResult.success || !flexResult.data?.length) {
            return res.status(400).json({
                error: true,
                message: "Transaction not found in Flexcube or validation failed"
            });
        }

        const flexTransaction = flexResult.data[0];

        // Additional validation for Transfer transactions
        if (Model === Transfer) {
            if (flexTransaction.TXN_ACC !== transaction.account_number ||
                flexTransaction.OFS_ACC !== transaction.beneficiary_account_number ||
                Number(flexTransaction.TXN_AMOUNT) !== Number(transaction.amount_in_figures)) {
                return res.status(400).json({
                    error: true,
                    message: "Transaction details mismatch with Flexcube records"
                });
            }
        } else {
            // For other transactions, verify amount
            if (Number(flexTransaction.TXN_AMOUNT) !== Number(transaction.amount_in_figures)) {
                return res.status(400).json({
                    error: true,
                    message: "Transaction amount mismatch with Flexcube records"
                });
            }
        }

        // Prepare update based on checker status
        let updateData;
        if (flexTransaction.MAKER_ID === flexTransaction.CHECKER_ID && flexTransaction.CHECKER_ID) {
            updateData = {
                status: 'authorized',
                authorized_date: new Date().toISOString(),
                authorizer_name: user.user,
                posted_by: user.user,
                posted_date: new Date().toISOString(),
                trn_ref_no: trn_ref_no
            };
        } else {
            updateData = {
                status: 'posted',
                posted_by: user.user,
                posted_date: new Date().toISOString(),
                trn_ref_no: trn_ref_no
            };
        }

        // Update transaction
        await Model.updateOne(
            { _id: transaction_id },
            { $set: updateData }
        );

        res.status(200).json({
            error: false,
            message: `Transaction successfully ${updateData.status}`,
            data: {
                transaction_id,
                status: updateData.status,
                posted_by: user.name,
                posted_date: new Date().toISOString()
            }
        });

    } catch(e) {
        console.error("[TRANSACTION_POSTED] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not perform the operation"
        });
    }
});



// No auth required — the 10-char alphanumeric reference number is the customer's proof
// Encrypted payload + valid reference number = authorization
router.put("/edit_smart_branch_request", async(req, res, next) => {
    try {
        // Encrypted payload is REQUIRED — reject plaintext requests
        let body = req.body;
        if (!body.encrypted || typeof body.encrypted !== 'string') {
            return res.status(400).json({ error: true, message: "Encrypted payload is required" });
        }
        try {
            body = decryptPayload(body.encrypted);
        } catch (decErr) {
            return res.status(400).json({ error: true, message: "Invalid or tampered request payload" });
        }

        const {
            amount_in_figures,
            amount_in_words,
            Customer_Unique_Number,
            request_type,
            account_number,
            beneficiary_account_number,
            beneficiary_name,
            payment_narration,
            beneficiary_bank,
            beneficiary_branch
        } = body;

        // Validate required fields
        if (!Customer_Unique_Number || !request_type) {
            return res.status(400).json({
                error: true,
                message: "Customer Unique Number and request type are required"
            });
        }

        // Validate reference number format (must be 10-char alphanumeric)
        if (!/^[A-Z0-9]{10}$/.test(Customer_Unique_Number)) {
            return res.status(400).json({
                error: true,
                message: "Invalid reference number format"
            });
        }

        // Verify the reference number exists (prevents blind Postman attacks)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const searchQuery = { Customer_Unique_Number, request_date: { $gte: today } };
        const exists = await Promise.any([
            Deposit.findOne(searchQuery).lean(),
            Withdraw.findOne(searchQuery).lean(),
            Transfer.findOne(searchQuery).lean(),
            Other_Bank_Transfer.findOne(searchQuery).lean(),
            ECheck.findOne(searchQuery).lean(),
        ].map(p => p.then(r => r || Promise.reject()))).catch(() => null);

        if (!exists) {
            return res.status(404).json({
                error: true,
                message: "Reference number not found or expired"
            });
        }

        let update = {};
        let result;

        switch(request_type.toLowerCase()) {
            case "withdraw":
                update = {
                    amount_in_figures,
                    amount_in_words
                };
                result = await Withdraw.findOneAndUpdate(
                    { Customer_Unique_Number },
                    update,
                    { new: true }
                );
                break;

            case "transfer":
                update = {
                    amount_in_figures,
                    amount_in_words,
                    beneficiary_name,
                    payment_narration,
                    beneficiary_account_number
                };
                result = await Transfer.findOneAndUpdate(
                    { Customer_Unique_Number },
                    update,
                    { new: true }
                );
                break;

            case "other_bank_transfer":
                update = {
                    amount_in_figures,
                    amount_in_words,
                    beneficiary_name,
                    payment_narration,
                    beneficiary_account_number,
                    beneficiary_bank,
                    beneficiary_branch
                };
                result = await Other_Bank_Transfer.findOneAndUpdate(
                    { Customer_Unique_Number },
                    update,
                    { new: true }
                );
                break;

            case "deposit":
                update = {
                    amount_in_figures,
                    amount_in_words
                };
                result = await Deposit.findOneAndUpdate(
                    { Customer_Unique_Number },
                    update,
                    { new: true }
                );
                break;

            default:
                return res.status(400).json({
                    error: true,
                    message: "Invalid request type"
                });
        }

        if (!result) {
            return res.status(404).json({
                error: true,
                message: "Transaction not found"
            });
        }

        return res.status(200).json({
            error: false,
            message: "Transaction updated successfully",
        });

    } catch (error) {
        console.error("[EDIT_REQUEST] Error:", error.message);
        return res.status(500).json({
            error: true,
            message: "Internal Server Error"
        });
    }
});

// Delete endpoint
// No auth required — encrypted payload + valid reference number = authorization
router.delete("/delete_smart_branch_request", async(req, res, next) => {
    try {
        // Encrypted payload is REQUIRED — reject plaintext requests
        let body = req.body;
        if (!body.encrypted || typeof body.encrypted !== 'string') {
            return res.status(400).json({ error: true, message: "Encrypted payload is required" });
        }
        try {
            body = decryptPayload(body.encrypted);
        } catch (decErr) {
            return res.status(400).json({ error: true, message: "Invalid or tampered request payload" });
        }

        const { Customer_Unique_Number, request_type } = body;

        // Validate required fields
        if (!Customer_Unique_Number || !request_type) {
            return res.status(400).json({
                error: true,
                message: "Customer Unique Number and request type are required"
            });
        }

        // Validate reference number format (must be 10-char alphanumeric)
        if (!/^[A-Z0-9]{10}$/.test(Customer_Unique_Number)) {
            return res.status(400).json({
                error: true,
                message: "Invalid reference number format"
            });
        }

        // Verify the reference number exists (prevents blind Postman attacks)
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const searchQuery = { Customer_Unique_Number, request_date: { $gte: today } };
        const exists = await Promise.any([
            Deposit.findOne(searchQuery).lean(),
            Withdraw.findOne(searchQuery).lean(),
            Transfer.findOne(searchQuery).lean(),
            Other_Bank_Transfer.findOne(searchQuery).lean(),
            ECheck.findOne(searchQuery).lean(),
        ].map(p => p.then(r => r || Promise.reject()))).catch(() => null);

        if (!exists) {
            return res.status(404).json({
                error: true,
                message: "Reference number not found or expired"
            });
        }

        let result;

        switch(request_type.toLowerCase()) {
            case "withdraw":
                result = await Withdraw.findOneAndDelete({ Customer_Unique_Number });
                break;

            case "transfer":
                result = await Transfer.findOneAndDelete({ Customer_Unique_Number });
                break;

            case "other_bank_transfer":
                result = await OtherBankTransfer.findOneAndDelete({ Customer_Unique_Number });
                break;

            case "deposit":
                result = await Deposit.findOneAndDelete({ Customer_Unique_Number });
                break;

            default:
                return res.status(400).json({
                    error: true,
                    message: "Invalid request type"
                });
        }

        if (!result) {
            return res.status(404).json({
                error: true,
                message: "Transaction not found"
            });
        }

        return res.status(200).json({
            error: false,
            message: "Transaction deleted successfully",
            
        });

    } catch (error) {
        console.error("[DELETE_REQUEST] Error:", error.message);
        return res.status(500).json({
            error: true,
            message: "Internal Server Error"
        });
    }
});


// No auth required — customer uses their 10-char reference number to look up requests
router.post("/get_account_number_by_reference_number", async (req, res, next) => {
    try {
        const { referenceNumber } = req.body;

        if (!referenceNumber) {
            return res.status(400).json({
                error: true,
                message: "Please provide a Reference Number"
            });
        }

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const searchQuery = {
            Customer_Unique_Number: referenceNumber,
            request_date: {
                $gte: today,
                $lt: new Date(today.getTime() + 24 * 60 * 60 * 1000)
            }
        };

        const deposits = await Deposit.find(searchQuery);
        const withdraws = await Withdraw.find(searchQuery);
        const transfers = await Transfer.find(searchQuery);
        const otherBankTransfers = await Other_Bank_Transfer.find(searchQuery);
        const airTicketPayments = await Air_Ticket_Payment.find(searchQuery);

        // Combine all transactions
        const transactions = [
            ...withdraws,
            ...deposits,
            ...transfers,
            ...otherBankTransfers,
            ...airTicketPayments
        ];

        if (transactions.length > 0) {
            // Prepare the response array
            const responseTransactions = transactions.map(t => {
                // Base information
                const baseInfo = {
                    request_type: t.request_type,
                    amount_in_figures: t.amount_in_figures,
                    account_number: t.account_number,
                    amount_in_words: t.amount_in_words,
                    Customer_Unique_Number: t.Customer_Unique_Number,
                };
        
                // Add additional fields based on request_type
                if (t.request_type === 'Transfer') {
                    return {
                        ...baseInfo,
                        beneficiary_account_number: t.beneficiary_account_number || null,
                        beneficiary_name: t.beneficiary_name || null,
                        payment_narration: t.payment_narration || null
                    };
                } else if (t.request_type === 'Other_Bank_Transfer') {
                    return {
                        ...baseInfo,
                        beneficiary_account_number: t.beneficiary_account_number || null,
                        beneficiary_name: t.beneficiary_name || null,
                        beneficiary_bank: t.beneficiary_bank || null,
                        beneficiary_branch: t.beneficiary_branch || null
                    };
                }
        
                // For other request types, return base info only
                return baseInfo;
            });
        
            return res.status(200).json({
                error: false,
                transactions: responseTransactions
            });
        } else {
            return res.status(400).json({
                error: true,
                message: "Invalid or Expired Reference Number"
            });
        }



    } catch (e) {
        console.error("[GET_ACCOUNT_BY_REF] Error:", e.message);
        return res.status(500).json({
            error: true,
            message: "Internal Server Error"
        });
    }
});



// router.post("/transaction_posted", auth, roleCheck(["Teller"]), async(req, res, next) => {
//     try {

//         console.log("Robel Asfaw Bogale", req.body);
//         // Get current user
//         const user = await User.findById(req.user._id).lean();
//         if (!user) {
//             return res.status(400).json({ error: true, message: "Requester not found" });
//         }

//         const { transactions } = req.body;
        
//         if (!transactions || !Array.isArray(transactions)) {
//             return res.status(400).json({ 
//                 error: true, 
//                 message: "Transactions array is required" 
//             });
//         }

//         const updateResults = {
//             totalModified: 0,
//             details: {},
//             skipped: [] // Track skipped transactions
//         };

//         // Process each transaction type
//         for (const transaction of transactions) {
//             let Model;
//             const type = transaction.transactionType.toLowerCase();

//             // Determine the model based on transaction type
//             switch(type) {
//                 case 'deposit':
//                     Model = Deposit;
//                     break;
//                 case 'withdraw':
//                     Model = Withdraw;
//                     break;
//                 case 'transfer':
//                     Model = Transfer;
//                     break;
//                 case 'other_bank_transfer':
//                     Model = Other_Bank_Transfer;
//                     break;
//                 case 'air_ticket_payment':
//                     Model = Air_Ticket_Payment;
//                     break;
//                 default:
//                     updateResults.skipped.push({
//                         id: transaction.id,
//                         reason: "Invalid transaction type"
//                     });
//                     continue;
//             }

//             // Check transaction status and assigned_to first
//             const existingTransaction = await Model.findOne({
//                 _id: transaction.id
//             }).select('status assigned_to');

//             if (!existingTransaction) {
//                 updateResults.skipped.push({
//                     id: transaction.id,
//                     reason: "Transaction not found"
//                 });
//                 continue;
//             }

//             if (existingTransaction.status !== 'assigned') {
//                 updateResults.skipped.push({
//                     id: transaction.id,
//                     reason: `Transaction status is ${existingTransaction.status}`
//                 });
//                 continue;
//             }

//             if (existingTransaction.assigned_to !== user.name) {
//                 updateResults.skipped.push({
//                     id: transaction.id,
//                     reason: `Transaction is assigned to ${existingTransaction.assigned_to}`
//                 });
//                 continue;
//             }

//             // Update transaction if status is 'assigned' and assigned_to is current user
//             const updateResult = await Model.updateOne(
//                 {
//                     _id: transaction.id,
//                     status: 'assigned',
//                     assigned_to: user.name
//                 },
//                 {
//                     $set: {
//                         posted_by: user.name,
//                         posted_date: new Date(),
//                         status: 'posted'
//                     }
//                 }
//             );

//             // Track successful updates
//             if (updateResult.modifiedCount > 0) {
//                 updateResults.totalModified += 1;
//                 updateResults.details[type] = (updateResults.details[type] || 0) + 1;
//             }
//         }

//         // Prepare response message
//         const responseMessage = updateResults.totalModified > 0
//             ? `Successfully posted ${updateResults.totalModified} transactions${
//                 updateResults.skipped.length > 0 
//                     ? `, skipped ${updateResults.skipped.length} transactions`
//                     : ''
//               }`
//             : "No transactions were updated";

//         res.status(200).json({
//             error: false,
//             message: responseMessage,
//             data: {
//                 totalModified: updateResults.totalModified,
//                 detailsByType: updateResults.details,
//                 skippedTransactions: updateResults.skipped,
//                 postedBy: user.name,
//                 postedDate: new Date()
//             }
//         });

//     } catch(e) {
//         console.log("Error", e);
//         res.status(500).json({ 
//             error: true, 
//             message: e.message || "Could not perform the operation" 
//         });
//     }
// });


router.get("/get_assigned_to_me", auth, roleCheck(["Teller", "Maker"]), async(req, res, next) => {
    try {
        // Get current user
        const user = await User.findById(req.user._id).lean();
        if (!user) {
            return res.status(400).json({ 
                error: true, 
                message: "User not found" 
            });
        }

        // Get today's date at midnight
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Query parameters for filtering
        const dateFilter = {
            request_date: {
                $gte: today,
                $lt: tomorrow
            }
        };

        // Fetch transactions from all models (parallel, lean, index-backed by
        // {assigned_to, request_date}).
        const [deposits, withdraws, echecks, transfers, otherBankTransfers, airTicketPayments] = await Promise.all([
            Deposit.find({
                assigned_to: user.user,
                ...dateFilter
            }).sort({ request_date: -1 }).lean(),

            Withdraw.find({
                assigned_to: user.user,
                ...dateFilter
            }).sort({ request_date: -1 }).lean(),

            ECheck.find({
                assigned_to: user.user,
                ...dateFilter
            }).sort({ request_date: -1 }).lean(),

            Transfer.find({
                assigned_to: user.user,
                ...dateFilter
            }).sort({ request_date: -1 }).lean(),

            Other_Bank_Transfer.find({
                assigned_to: user.user,
                ...dateFilter
            }).sort({ request_date: -1 }).lean(),

            Air_Ticket_Payment.find({
                assigned_to: user.user,
                ...dateFilter
            }).sort({ request_date: -1 }).lean()
        ]);

        // Combine all transactions (lean docs are already plain objects).
        // Images are intentionally NOT fetched here: the per-load Flexcube/Oracle
        // image lookup (one round-trip + base64 transfer on EVERY load) cannot
        // survive teller-fleet traffic and was the main source of lag. The result
        // table never showed these images — profile_image/sign_image are now
        // fetched ON DEMAND via GET /account_images/:account_number when a teller
        // opens a row's details.
        const finalTransactions = [
            ...deposits.map(t => ({ ...t, transactionType: 'deposit' })),
            ...withdraws.map(t => ({ ...t, transactionType: 'withdraw' })),
            ...echecks.map(t => ({ ...t, transactionType: 'echeck' })),
            ...transfers.map(t => ({ ...t, transactionType: 'transfer' })),
            ...otherBankTransfers.map(t => ({ ...t, transactionType: 'other_bank_transfer' })),
            ...airTicketPayments.map(t => ({ ...t, transactionType: 'air_ticket_payment' })),
        ].sort((a, b) => new Date(b.request_date) - new Date(a.request_date));

        // Calculate summary
        const summary = {
            total: finalTransactions.length,
            byType: {
                deposits: deposits.length,
                withdraws: withdraws.length,
                transfers: transfers.length,
                otherBankTransfers: otherBankTransfers.length,
                airTicketPayments: airTicketPayments.length
            },
            byStatus: finalTransactions.reduce((acc, curr) => {
                acc[curr.status] = (acc[curr.status] || 0) + 1;
                return acc;
            }, {})
        };

        res.status(200).json({
            error: false,
            data: {
                transactions: finalTransactions,
                summary
            }
        });

    } catch(e) {
        console.error("[GET_ALL_DATA] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not retrieve transactions"
        });
    }
});


router.get("/get_posted_data", auth, roleCheck(["Authorizer","Teller"]), async(req, res, next) => {
    try {
        // Get current user
        const user = await User.findById(req.user._id).lean();
        if (!user) {
            return res.status(400).json({ 
                error: true, 
                message: "User not found" 
            });
        }

        // Get today's date at midnight
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Query parameters for filtering
        const dateFilter = {
            request_date: {
                $gte: today,
                $lt: tomorrow
            }
        };

        // Fetch transactions from all models with status 'posted' and matching branch
        const [deposits, withdraws, transfers, otherBankTransfers, airTicketPayments] = await Promise.all([
            Deposit.find({ 
                status: 'posted',
                branch: user.branch,
                ...dateFilter
            }).sort({ request_date: -1 }),
            
            Withdraw.find({ 
                status: 'posted',
                branch: user.branch,
                ...dateFilter
            }).sort({ request_date: -1 }),
            
            Transfer.find({ 
                status: 'posted',
                branch: user.branch,
                ...dateFilter
            }).sort({ request_date: -1 }),
            
            Other_Bank_Transfer.find({ 
                status: 'posted',
                branch: user.branch,
                ...dateFilter
            }).sort({ request_date: -1 }),
            
            Air_Ticket_Payment.find({ 
                status: 'posted',
                branch: user.branch,
                ...dateFilter
            }).sort({ request_date: -1 })
        ]);

        // Combine all transactions
        const transformedTransactions = [
            ...deposits.map(t => ({
                ...t.toObject(),
                transactionType: 'deposit'
            })),
            ...withdraws.map(t => ({
                ...t.toObject(),
                transactionType: 'withdraw'
            })),
            ...transfers.map(t => ({
                ...t.toObject(),
                transactionType: 'transfer'
            })),
            ...otherBankTransfers.map(t => ({
                ...t.toObject(),
                transactionType: 'other_bank_transfer'
            })),
            ...airTicketPayments.map(t => ({
                ...t.toObject(),
                transactionType: 'air_ticket_payment'
            }))
        ];

        // Get unique account numbers
        const accountNumbers = [...new Set(transformedTransactions.map(t => t.account_number))];

        // Only proceed with Oracle query if there are transactions
        let finalTransactions = transformedTransactions;
        
        if (accountNumbers.length > 0) {
            // Fetch images from Oracle DB
            const imagesQuery = `
                SELECT 
                    CA.CUST_AC_NO,
                    CI.IMAGE_TEXT AS PROFILE_IMAGE,
                    SI.SIG_TEXT AS SIGN_IMAGE
                FROM fcubsprd.STTM_CUST_ACCOUNT CA
                LEFT JOIN fcubsprd.STTM_CUST_IMAGE CI ON CA.CUST_NO = CI.CUSTOMER_NO
                LEFT JOIN fcubsprd.svtm_cif_sig_det SI ON CA.CUST_NO = SI.CIF_ID
                WHERE CA.CUST_AC_NO IN (${accountNumbers.map((_, i) => `:${i + 1}`).join(',')})
            `;

            const imagesResult = await executeQuery(
                imagesQuery,
                accountNumbers,
                {
                    fetchInfo: {
                        PROFILE_IMAGE: { type: oracledb.STRING },
                        SIGN_IMAGE: { type: oracledb.STRING }
                    }
                }
            );

            // Create a map of account numbers to their images
            const accountImages = {};
            if (imagesResult.success && imagesResult.data) {
                imagesResult.data.forEach(row => {
                    accountImages[row.CUST_AC_NO] = {
                        profile_image: row.PROFILE_IMAGE ? 
                            `data:image/jpeg;base64,${row.PROFILE_IMAGE}` : null,
                        sign_image: row.SIGN_IMAGE ? 
                            `data:image/jpeg;base64,${row.SIGN_IMAGE}` : null
                    };
                });
            }

            // Add images to transactions and sort by request_date
            finalTransactions = transformedTransactions
                .map(transaction => ({
                    ...transaction,
                    profile_image: accountImages[transaction.account_number]?.profile_image || null,
                    sign_image: accountImages[transaction.account_number]?.sign_image || null
                }))
                .sort((a, b) => new Date(b.request_date) - new Date(a.request_date));
        }

        // Calculate summary
        const summary = {
            total: finalTransactions.length,
            byType: {
                deposits: deposits.length,
                withdraws: withdraws.length,
                transfers: transfers.length,
                otherBankTransfers: otherBankTransfers.length,
                airTicketPayments: airTicketPayments.length
            },
            byStatus: finalTransactions.reduce((acc, curr) => {
                acc[curr.status] = (acc[curr.status] || 0) + 1;
                return acc;
            }, {})
        };

        res.status(200).json({
            error: false,
            data: {
                transactions: finalTransactions,
                summary
            }
        });

    } catch(e) {
        console.error("[GET_POSTED_DATA] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not retrieve transactions"
        });
    }
});



router.get("/get_authorized_data", auth, roleCheck(["Auditor","Teller"]), async(req, res, next) => {
    try {
        // Get current user
        const user = await User.findById(req.user._id).lean();
        if (!user) {
            return res.status(400).json({ 
                error: true, 
                message: "User not found" 
            });
        }

        // Get today's date at midnight
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        // Query parameters for filtering
        const dateFilter = {
            request_date: {
                $gte: today,
                $lt: tomorrow
            }
        };

        // Fetch this branch's transactions the Auditor can act on: status
        // 'posted' OR 'authorized' (the audit step accepts both), matching branch.
        const [deposits, withdraws, transfers, otherBankTransfers, airTicketPayments] = await Promise.all([
            Deposit.find({ 
                status: { $in: ['posted', 'authorized'] },
                branch: user.branch,
                ...dateFilter
            }).sort({ request_date: -1 }),
            
            Withdraw.find({ 
                status: { $in: ['posted', 'authorized'] },
                branch: user.branch,
                ...dateFilter
            }).sort({ request_date: -1 }),
            
            Transfer.find({ 
                status: { $in: ['posted', 'authorized'] },
                branch: user.branch,
                ...dateFilter
            }).sort({ request_date: -1 }),
            
            Other_Bank_Transfer.find({ 
                status: { $in: ['posted', 'authorized'] },
                branch: user.branch,
                ...dateFilter
            }).sort({ request_date: -1 }),
            
            Air_Ticket_Payment.find({ 
                status: { $in: ['posted', 'authorized'] },
                branch: user.branch,
                ...dateFilter
            }).sort({ request_date: -1 })
        ]);

        // Combine all transactions
        const transformedTransactions = [
            ...deposits.map(t => ({
                ...t.toObject(),
                transactionType: 'deposit'
            })),
            ...withdraws.map(t => ({
                ...t.toObject(),
                transactionType: 'withdraw'
            })),
            ...transfers.map(t => ({
                ...t.toObject(),
                transactionType: 'transfer'
            })),
            ...otherBankTransfers.map(t => ({
                ...t.toObject(),
                transactionType: 'other_bank_transfer'
            })),
            ...airTicketPayments.map(t => ({
                ...t.toObject(),
                transactionType: 'air_ticket_payment'
            }))
        ];

        // Get unique account numbers
        const accountNumbers = [...new Set(transformedTransactions.map(t => t.account_number))];

        // Only proceed with Oracle query if there are transactions
        let finalTransactions = transformedTransactions;
        
        if (accountNumbers.length > 0) {
            // Fetch images from Oracle DB
            const imagesQuery = `
                SELECT 
                    CA.CUST_AC_NO,
                    CI.IMAGE_TEXT AS PROFILE_IMAGE,
                    SI.SIG_TEXT AS SIGN_IMAGE
                FROM fcubsprd.STTM_CUST_ACCOUNT CA
                LEFT JOIN fcubsprd.STTM_CUST_IMAGE CI ON CA.CUST_NO = CI.CUSTOMER_NO
                LEFT JOIN fcubsprd.svtm_cif_sig_det SI ON CA.CUST_NO = SI.CIF_ID
                WHERE CA.CUST_AC_NO IN (${accountNumbers.map((_, i) => `:${i + 1}`).join(',')})
            `;

            const imagesResult = await executeQuery(
                imagesQuery,
                accountNumbers,
                {
                    fetchInfo: {
                        PROFILE_IMAGE: { type: oracledb.STRING },
                        SIGN_IMAGE: { type: oracledb.STRING }
                    }
                }
            );

            // Create a map of account numbers to their images
            const accountImages = {};
            if (imagesResult.success && imagesResult.data) {
                imagesResult.data.forEach(row => {
                    accountImages[row.CUST_AC_NO] = {
                        profile_image: row.PROFILE_IMAGE ? 
                            `data:image/jpeg;base64,${row.PROFILE_IMAGE}` : null,
                        sign_image: row.SIGN_IMAGE ? 
                            `data:image/jpeg;base64,${row.SIGN_IMAGE}` : null
                    };
                });
            }

            // Add images to transactions and sort by request_date
            finalTransactions = transformedTransactions
                .map(transaction => ({
                    ...transaction,
                    profile_image: accountImages[transaction.account_number]?.profile_image || null,
                    sign_image: accountImages[transaction.account_number]?.sign_image || null
                }))
                .sort((a, b) => new Date(b.request_date) - new Date(a.request_date));
        }

        // Calculate summary
        const summary = {
            total: finalTransactions.length,
            byType: {
                deposits: deposits.length,
                withdraws: withdraws.length,
                transfers: transfers.length,
                otherBankTransfers: otherBankTransfers.length,
                airTicketPayments: airTicketPayments.length
            },
            byStatus: finalTransactions.reduce((acc, curr) => {
                acc[curr.status] = (acc[curr.status] || 0) + 1;
                return acc;
            }, {}),
            byAuthorizer: finalTransactions.reduce((acc, curr) => {
                const authorizerName = curr.authorized_by || 'Unknown';
                acc[authorizerName] = (acc[authorizerName] || 0) + 1;
                return acc;
            }, {})
        };

        res.status(200).json({
            error: false,
            data: {
                transactions: finalTransactions,
                summary
            }
        });

    } catch(e) {
        console.error("[GET_AUTHORIZED_DATA] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not retrieve transactions"
        });
    }
});




router.post("/transaction_authorized", auth, roleCheck(["Teller", "Authorizer"]), async(req, res, next) => {
    try {
        // Get current user
        const user = await User.findById(req.user._id).lean();
        if (!user) {
            return res.status(400).json({ error: true, message: "Requester not found" });
        }

        const { transactions } = req.body;
        
        if (!transactions || !Array.isArray(transactions)) {
            return res.status(400).json({ 
                error: true, 
                message: "Transactions array is required" 
            });
        }

        const updateResults = {
            totalModified: 0,
            details: {},
            skipped: [] // Track skipped transactions
        };

        // Process each transaction
        for (const transaction of transactions) {
            let Model;
            const type = transaction.transactionType.toLowerCase();

            // Determine the model based on transaction type
            switch(type) {
                case 'deposit':
                    Model = Deposit;
                    break;
                case 'withdraw':
                    Model = Withdraw;
                    break;
                case 'transfer':
                    Model = Transfer;
                    break;
                case 'other_bank_transfer':
                    Model = Other_Bank_Transfer;
                    break;
                case 'air_ticket_payment':
                    Model = Air_Ticket_Payment;
                    break;
                default:
                    updateResults.skipped.push({
                        id: transaction.id,
                        reason: "Invalid transaction type"
                    });
                    continue;
            }

            // Check transaction status and get trn_ref_no
            const existingTransaction = await Model.findOne({
                _id: transaction.id
            }).select('status trn_ref_no posted_by branch');

            if (!existingTransaction) {
                updateResults.skipped.push({
                    id: transaction.id,
                    reason: "Transaction not found"
                });
                continue;
            }

            // Check if status is posted
            if (existingTransaction.status !== 'posted') {
                updateResults.skipped.push({
                    id: transaction.id,
                    reason: `Transaction status is ${existingTransaction.status}, expected 'posted'`
                });
                continue;
            }

            // Check if branch matches user's branch
            if (existingTransaction.branch !== user.branch) {
                updateResults.skipped.push({
                    id: transaction.id,
                    reason: `Transaction branch mismatch`
                });
                continue;
            }

            // Prevent self-authorization
            if (existingTransaction.posted_by === user.name) {
                updateResults.skipped.push({
                    id: transaction.id,
                    reason: "Cannot authorize transactions you posted"
                });
                continue;
            }

            // Query Flexcube to verify CHECKER_ID
            const flexQuery = `
                SELECT CHECKER_ID
                FROM fcubsprd.detb_rtl_teller 
                WHERE trn_ref_no = :1 
                AND CHECKER_ID = :2
            `;

            const flexResult = await executeQuery(flexQuery, [
                existingTransaction.trn_ref_no,
                user.flex_id
            ]);

            // Skip if CHECKER_ID doesn't match
            if (!flexResult.success || !flexResult.data?.length) {
                updateResults.skipped.push({
                    id: transaction.id,
                    reason: "Transaction not authorized by you in Flexcube"
                });
                continue;
            }

            // Update transaction if all checks pass
            const updateResult = await Model.updateOne(
                {
                    _id: transaction.id,
                    status: 'posted'
                },
                {
                    $set: {
                        authorizer_name: user.user,
                        authorized_date: new Date().toISOString(),
                        status: 'authorized'
                    }
                }
            );

            // Track successful updates
            if (updateResult.modifiedCount > 0) {
                updateResults.totalModified += 1;
                updateResults.details[type] = (updateResults.details[type] || 0) + 1;
            }
        }

        // Prepare response message
        const responseMessage = updateResults.totalModified > 0
            ? `Successfully authorized ${updateResults.totalModified} transactions${
                updateResults.skipped.length > 0 
                    ? `, skipped ${updateResults.skipped.length} transactions`
                    : ''
              }`
            : "No transactions were authorized";

        res.status(200).json({
            error: false,
            message: responseMessage,
            data: {
                totalModified: updateResults.totalModified,
                detailsByType: updateResults.details,
                skippedTransactions: updateResults.skipped,
                authorizer_name: user.user,
                authorized_date: new Date().toISOString()
            }
        });

    } catch(e) {
        console.error("[TRANSACTION_AUTHORIZED] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not perform the operation"
        });
    }
});






// router.post("/transaction_authorized", auth, roleCheck(["Authorizer"]), async(req, res, next) => {
//     try {

//         console.log("req.user", req.body);
//         // Get current user
//         const user = await User.findById(req.user._id).lean();
//         if (!user) {
//             return res.status(400).json({ error: true, message: "Requester not found" });
//         }

//         const { transactions } = req.body;
        
//         if (!transactions || !Array.isArray(transactions)) {
//             return res.status(400).json({ 
//                 error: true, 
//                 message: "Transactions array is required" 
//             });
//         }

//         const updateResults = {
//             totalModified: 0,
//             details: {},
//             skipped: [] // Track skipped transactions
//         };

//         // Process each transaction
//         for (const transaction of transactions) {
//             let Model;
//             const type = transaction.transactionType.toLowerCase();

//             // Determine the model based on transaction type
//             switch(type) {
//                 case 'deposit':
//                     Model = Deposit;
//                     break;
//                 case 'withdraw':
//                     Model = Withdraw;
//                     break;
//                 case 'transfer':
//                     Model = Transfer;
//                     break;
//                 case 'other_bank_transfer':
//                     Model = Other_Bank_Transfer;
//                     break;
//                 case 'air_ticket_payment':
//                     Model = Air_Ticket_Payment;
//                     break;
//                 default:
//                     updateResults.skipped.push({
//                         id: transaction.id,
//                         reason: "Invalid transaction type"
//                     });
//                     continue;
//             }

//             // Check transaction status and branch
//             const existingTransaction = await Model.findOne({
//                 _id: transaction.id
//             }).select('status branch posted_by');

//             if (!existingTransaction) {
//                 updateResults.skipped.push({
//                     id: transaction.id,
//                     reason: "Transaction not found"
//                 });
//                 continue;
//             }

//             // Check if status is posted
//             if (existingTransaction.status !== 'posted') {
//                 updateResults.skipped.push({
//                     id: transaction.id,
//                     reason: `Transaction status is ${existingTransaction.status}, expected 'posted'`
//                 });
//                 continue;
//             }

//             // Check if branch matches user's branch
//             if (existingTransaction.branch !== user.branch) {
//                 updateResults.skipped.push({
//                     id: transaction.id,
//                     reason: `Transaction branch (${existingTransaction.branch}) does not match authorizer branch (${user.branch})`
//                 });
//                 continue;
//             }

//             // Prevent self-authorization
//             if (existingTransaction.posted_by === user.name) {
//                 updateResults.skipped.push({
//                     id: transaction.id,
//                     reason: "Cannot authorize own posted transaction"
//                 });
//                 continue;
//             }

//             // Update transaction if all checks pass
//             const updateResult = await Model.updateOne(
//                 {
//                     _id: transaction.id,
//                     status: 'posted',
//                     branch: user.branch
//                 },
//                 {
//                     $set: {
//                         authorizer_name: user.name,
//                         authorized_date: new Date(),
//                         status: 'authorized'
//                     }
//                 }
//             );

//             // Track successful updates
//             if (updateResult.modifiedCount > 0) {
//                 updateResults.totalModified += 1;
//                 updateResults.details[type] = (updateResults.details[type] || 0) + 1;
//             }
//         }

//         // Prepare response message
//         const responseMessage = updateResults.totalModified > 0
//             ? `Successfully authorized ${updateResults.totalModified} transactions${
//                 updateResults.skipped.length > 0 
//                     ? `, skipped ${updateResults.skipped.length} transactions`
//                     : ''
//               }`
//             : "No transactions were authorized";

//         res.status(200).json({
//             error: false,
//             message: responseMessage,
//             data: {
//                 totalModified: updateResults.totalModified,
//                 detailsByType: updateResults.details,
//                 skippedTransactions: updateResults.skipped,
//                 authorizedBy: user.name,
//                 authorizedDate: new Date()
//             }
//         });

//     } catch(e) {
//         console.log("Error", e);
//         res.status(500).json({ 
//             error: true, 
//             message: e.message || "Could not perform the operation" 
//         });
//     }
// });


router.post("/transaction_audited", auth, roleCheck(["Auditor"]), async(req, res, next) => {
    try {
        // Get current user
        const user = await User.findById(req.user._id).lean();
        if (!user) {
            return res.status(400).json({ error: true, message: "Requester not found" });
        }

        const { transactions } = req.body;
        
        if (!transactions || !Array.isArray(transactions)) {
            return res.status(400).json({ 
                error: true, 
                message: "Transactions array is required" 
            });
        }

        const updateResults = {
            totalModified: 0,
            details: {},
            skipped: [] // Track skipped transactions
        };

        // Process each transaction
        for (const transaction of transactions) {
            let Model;
            const type = transaction.transactionType.toLowerCase();

            // Determine the model based on transaction type
            switch(type) {
                case 'deposit':
                    Model = Deposit;
                    break;
                case 'withdraw':
                    Model = Withdraw;
                    break;
                case 'transfer':
                    Model = Transfer;
                    break;
                case 'other_bank_transfer':
                    Model = Other_Bank_Transfer;
                    break;
                case 'air_ticket_payment':
                    Model = Air_Ticket_Payment;
                    break;
                default:
                    updateResults.skipped.push({
                        id: transaction.id,
                        reason: "Invalid transaction type"
                    });
                    continue;
            }

            // Check transaction status, branch and authorization details
            const existingTransaction = await Model.findOne({
                _id: transaction.id
            }).select('status branch authorized_by');

            if (!existingTransaction) {
                updateResults.skipped.push({
                    id: transaction.id,
                    reason: "Transaction not found"
                });
                continue;
            }

            // Check if status is posted or authorized
            if (existingTransaction.status !== 'authorized' && existingTransaction.status !== 'posted') {
                updateResults.skipped.push({
                    id: transaction.id,
                    reason: `Transaction status is '${existingTransaction.status}', expected 'posted' or 'authorized'`
                });
                continue;
            }

            // Check if branch matches user's branch
            if (existingTransaction.branch !== user.branch) {
                updateResults.skipped.push({
                    id: transaction.id,
                    reason: `Transaction branch (${existingTransaction.branch}) does not match auditor branch (${user.branch})`
                });
                continue;
            }

            // Prevent self-auditing if user was the authorizer
            if (existingTransaction.authorized_by === user.user) {
                updateResults.skipped.push({
                    id: transaction.id,
                    reason: "Cannot audit transactions you authorized"
                });
                continue;
            }

            // Update transaction if all checks pass
            const updateResult = await Model.updateOne(
                {
                    _id: transaction.id,
                    status: { $in: ['posted', 'authorized'] },
                    branch: user.branch
                },
                {
                    $set: {
                        audit_by: user.user,
                        audit_date: new Date().toISOString(),
                        status: 'audited'
                    }
                }
            );

            // Track successful updates
            if (updateResult.modifiedCount > 0) {
                updateResults.totalModified += 1;
                updateResults.details[type] = (updateResults.details[type] || 0) + 1;
            }
        }

        // Prepare response message
        const responseMessage = updateResults.totalModified > 0
            ? `Successfully audited ${updateResults.totalModified} transactions${
                updateResults.skipped.length > 0 
                    ? `, skipped ${updateResults.skipped.length} transactions`
                    : ''
              }`
            : "No transactions were audited";

        res.status(200).json({
            error: false,
            message: responseMessage,
            data: {
                totalModified: updateResults.totalModified,
                detailsByType: updateResults.details,
                skippedTransactions: updateResults.skipped,
                auditedBy: user.user,
                auditDate: new Date().toISOString()
            }
        });

    } catch(e) {
        console.error("[TRANSACTION_AUDITED] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not perform the operation"
        });
    }
});



// router.get("/branch_transactions", auth, async(req, res, next) => {
//     try {
//         // Get current user
//         const user = await User.findById(req.user._id).lean();
//         if (!user) {
//             return res.status(400).json({ 
//                 error: true, 
//                 message: "User not found" 
//             });
//         }

//         // Fetch all transactions from user's branch
//         const [deposits, withdraws, transfers, otherBankTransfers, airTicketPayments] = await Promise.all([
//             Deposit.find({ branch: user.branch })
//                 .sort({ request_date: -1 }),
            
//             Withdraw.find({ branch: user.branch })
//                 .sort({ request_date: -1 }),
            
//             Transfer.find({ branch: user.branch })
//                 .sort({ request_date: -1 }),
            
//             Other_Bank_Transfer.find({ branch: user.branch })
//                 .sort({ request_date: -1 }),
            
//             Air_Ticket_Payment.find({ branch: user.branch })
//                 .sort({ request_date: -1 })
//         ]);

//         // Combine all transactions with their types
//         const transformedTransactions = [
//             ...deposits.map(t => ({
//                 ...t.toObject(),
//                 transactionType: 'deposit'
//             })),
//             ...withdraws.map(t => ({
//                 ...t.toObject(),
//                 transactionType: 'withdraw'
//             })),
//             ...transfers.map(t => ({
//                 ...t.toObject(),
//                 transactionType: 'transfer'
//             })),
//             ...otherBankTransfers.map(t => ({
//                 ...t.toObject(),
//                 transactionType: 'other_bank_transfer'
//             })),
//             ...airTicketPayments.map(t => ({
//                 ...t.toObject(),
//                 transactionType: 'air_ticket_payment'
//             }))
//         ];

//         // Get unique account numbers
//         const accountNumbers = [...new Set(transformedTransactions.map(t => t.account_number))];

//         let finalTransactions = transformedTransactions;

//         if (accountNumbers.length > 0) {
//             // Fetch images from Oracle DB
//             const imagesQuery = `
//                 SELECT 
//                     CA.CUST_AC_NO,
//                     CI.IMAGE_TEXT AS PROFILE_IMAGE,
//                     SI.SIG_TEXT AS SIGN_IMAGE
//                 FROM fcubsprd.STTM_CUST_ACCOUNT CA
//                 LEFT JOIN fcubsprd.STTM_CUST_IMAGE CI ON CA.CUST_NO = CI.CUSTOMER_NO
//                 LEFT JOIN fcubsprd.svtm_cif_sig_det SI ON CA.CUST_NO = SI.CIF_ID
//                 WHERE CA.CUST_AC_NO IN (${accountNumbers.map((_, i) => `:${i + 1}`).join(',')})
//             `;

//             const imagesResult = await executeQuery(
//                 imagesQuery,
//                 accountNumbers,
//                 {
//                     fetchInfo: {
//                         PROFILE_IMAGE: { type: oracledb.STRING },
//                         SIGN_IMAGE: { type: oracledb.STRING }
//                     }
//                 }
//             );

//             // Create a map of account numbers to their images
//             const accountImages = {};
//             if (imagesResult.success && imagesResult.data) {
//                 imagesResult.data.forEach(row => {
//                     accountImages[row.CUST_AC_NO] = {
//                         profile_image: row.PROFILE_IMAGE ? 
//                             `data:image/jpeg;base64,${row.PROFILE_IMAGE}` : null,
//                         sign_image: row.SIGN_IMAGE ? 
//                             `data:image/jpeg;base64,${row.SIGN_IMAGE}` : null
//                     };
//                 });
//             }

//             // Add images to transactions and sort by request_date
//             finalTransactions = transformedTransactions
//                 .map(transaction => ({
//                     ...transaction,
//                     profile_image: accountImages[transaction.account_number]?.profile_image || null,
//                     sign_image: accountImages[transaction.account_number]?.sign_image || null
//                 }))
//                 .sort((a, b) => new Date(b.request_date) - new Date(a.request_date));
//         }

//         // Calculate summary
//         const summary = {
//             total: finalTransactions.length,
//             byType: {
//                 deposits: deposits.length,
//                 withdraws: withdraws.length,
//                 transfers: transfers.length,
//                 otherBankTransfers: otherBankTransfers.length,
//                 airTicketPayments: airTicketPayments.length
//             },
//             byStatus: finalTransactions.reduce((acc, curr) => {
//                 acc[curr.status] = (acc[curr.status] || 0) + 1;
//                 return acc;
//             }, {})
//         };

//         res.status(200).json({
//             error: false,
//             data: {
//                 branch: user.branch,
//                 transactions: finalTransactions,
//                 summary
//             }
//         });

//     } catch(e) {
//         console.log("Error", e);
//         res.status(500).json({ 
//             error: true, 
//             message: e.message || "Could not retrieve transactions" 
//         });
//     }
// });





router.get("/branch_transactions", auth, async(req, res, next) => {
    try {
        // Get current user
        const user = await User.findById(req.user._id).lean();
        if (!user) {
            return res.status(400).json({ 
                error: true, 
                message: "User not found" 
            });
        }

        // Determine the query condition based on user role
        const isTellerOrMaker = req.user.roles.includes('Teller') || req.user.roles.includes('Maker');
        const isBranchManagement = req.user.roles.includes('Branch_Management');
        const queryCondition = isBranchManagement ? {} : (isTellerOrMaker ? { assigned_to: user.user } : { branch: user.branch });

        // ===== OPT-IN SERVER-SIDE PAGINATION (table) =====
        // With start/size, return just one page (+ true totalRowCount) instead of
        // every transaction. Each collection is already sorted request_date desc,
        // so capping each at start+size, merging, re-sorting and slicing yields the
        // correct global page. Oracle images are fetched ONLY for the page's rows.
        // With no start/size, the original full-response path below runs unchanged.
        const { start, size } = req.query;
        const hasPagination = start !== undefined && size !== undefined
            && !Number.isNaN(Number(start)) && !Number.isNaN(Number(size));
        if (hasPagination) {
            const pageModels = [
                [Deposit, 'deposit'], [Withdraw, 'withdraw'], [ECheck, 'echeck'],
                [Transfer, 'transfer'], [Other_Bank_Transfer, 'other_bank_transfer'],
                [Air_Ticket_Payment, 'air_ticket_payment'],
            ];
            const cap = Number(start) + Number(size);
            const perCollection = await Promise.all(
                pageModels.map(([Model]) => Model.find(queryCondition).sort({ request_date: -1 }).limit(cap).lean())
            );
            let merged = [];
            perCollection.forEach((rows, i) => {
                const transactionType = pageModels[i][1];
                for (const r of rows) merged.push({ ...r, transactionType });
            });
            merged.sort((a, b) => new Date(b.request_date) - new Date(a.request_date));
            let pageRows = merged.slice(Number(start), Number(start) + Number(size));

            // Enrich only the page's rows with Oracle images (same query as the full path).
            const pageAccountNumbers = [...new Set(pageRows.map(t => t.account_number).filter(Boolean))];
            if (pageAccountNumbers.length > 0) {
                const imagesQuery = `
                    SELECT
                        CA.CUST_AC_NO,
                        CI.IMAGE_TEXT AS PROFILE_IMAGE,
                        SI.SIG_TEXT AS SIGN_IMAGE
                    FROM fcubsprd.STTM_CUST_ACCOUNT CA
                    LEFT JOIN fcubsprd.STTM_CUST_IMAGE CI ON CA.CUST_NO = CI.CUSTOMER_NO
                    LEFT JOIN fcubsprd.svtm_cif_sig_det SI ON CA.CUST_NO = SI.CIF_ID
                    WHERE CA.CUST_AC_NO IN (${pageAccountNumbers.map((_, i) => `:${i + 1}`).join(',')})
                `;
                const imagesResult = await executeQuery(imagesQuery, pageAccountNumbers, {
                    fetchInfo: {
                        PROFILE_IMAGE: { type: oracledb.STRING },
                        SIGN_IMAGE: { type: oracledb.STRING },
                    },
                });
                const accountImages = {};
                if (imagesResult.success && imagesResult.data) {
                    imagesResult.data.forEach(row => {
                        accountImages[row.CUST_AC_NO] = {
                            profile_image: row.PROFILE_IMAGE ? `data:image/jpeg;base64,${row.PROFILE_IMAGE}` : null,
                            sign_image: row.SIGN_IMAGE ? `data:image/jpeg;base64,${row.SIGN_IMAGE}` : null,
                        };
                    });
                }
                pageRows = pageRows.map(t => ({
                    ...t,
                    profile_image: accountImages[t.account_number]?.profile_image || null,
                    sign_image: accountImages[t.account_number]?.sign_image || null,
                }));
            }

            const counts = await Promise.all(pageModels.map(([Model]) => Model.countDocuments(queryCondition)));
            const totalRowCount = counts.reduce((a, c) => a + c, 0);

            const pageResponse = { error: false, data: { transactions: pageRows }, meta: { totalRowCount } };
            if (!isBranchManagement) {
                pageResponse.data.branch = user.branch;
                if (isTellerOrMaker) pageResponse.data.assigned_to = user.user;
            }
            return res.status(200).json(pageResponse);
        }

        // Fetch all transactions based on the query condition
        const [deposits, withdraws, echecks, transfers, otherBankTransfers, airTicketPayments] = await Promise.all([
            Deposit.find(queryCondition)
                .sort({ request_date: -1 }),

            Withdraw.find(queryCondition)
                .sort({ request_date: -1 }),

            ECheck.find(queryCondition)
                .sort({ request_date: -1 }),

            Transfer.find(queryCondition)
                .sort({ request_date: -1 }),

            Other_Bank_Transfer.find(queryCondition)
                .sort({ request_date: -1 }),

            Air_Ticket_Payment.find(queryCondition)
                .sort({ request_date: -1 })
        ]);

        // Combine all transactions with their types
        const transformedTransactions = [
            ...deposits.map(t => ({
                ...t.toObject(),
                transactionType: 'deposit'
            })),
            ...withdraws.map(t => ({
                ...t.toObject(),
                transactionType: 'withdraw'
            })),
            ...echecks.map(t => ({
                ...t.toObject(),
                transactionType: 'echeck'
            })),
            ...transfers.map(t => ({
                ...t.toObject(),
                transactionType: 'transfer'
            })),
            ...otherBankTransfers.map(t => ({
                ...t.toObject(),
                transactionType: 'other_bank_transfer'
            })),
            ...airTicketPayments.map(t => ({
                ...t.toObject(),
                transactionType: 'air_ticket_payment'
            }))
        ];

        // Get unique account numbers
        const accountNumbers = [...new Set(transformedTransactions.map(t => t.account_number))];

        let finalTransactions = transformedTransactions;

        if (accountNumbers.length > 0) {
            // Fetch images from Oracle DB
            const imagesQuery = `
                SELECT 
                    CA.CUST_AC_NO,
                    CI.IMAGE_TEXT AS PROFILE_IMAGE,
                    SI.SIG_TEXT AS SIGN_IMAGE
                FROM fcubsprd.STTM_CUST_ACCOUNT CA
                LEFT JOIN fcubsprd.STTM_CUST_IMAGE CI ON CA.CUST_NO = CI.CUSTOMER_NO
                LEFT JOIN fcubsprd.svtm_cif_sig_det SI ON CA.CUST_NO = SI.CIF_ID
                WHERE CA.CUST_AC_NO IN (${accountNumbers.map((_, i) => `:${i + 1}`).join(',')})
            `;

            const imagesResult = await executeQuery(
                imagesQuery,
                accountNumbers,
                {
                    fetchInfo: {
                        PROFILE_IMAGE: { type: oracledb.STRING },
                        SIGN_IMAGE: { type: oracledb.STRING }
                    }
                }
            );

            // Create a map of account numbers to their images
            const accountImages = {};
            if (imagesResult.success && imagesResult.data) {
                imagesResult.data.forEach(row => {
                    accountImages[row.CUST_AC_NO] = {
                        profile_image: row.PROFILE_IMAGE ? 
                            `data:image/jpeg;base64,${row.PROFILE_IMAGE}` : null,
                        sign_image: row.SIGN_IMAGE ? 
                            `data:image/jpeg;base64,${row.SIGN_IMAGE}` : null
                    };
                });
            }

            // Add images to transactions and sort by request_date
            finalTransactions = transformedTransactions
                .map(transaction => ({
                    ...transaction,
                    profile_image: accountImages[transaction.account_number]?.profile_image || null,
                    sign_image: accountImages[transaction.account_number]?.sign_image || null
                }))
                .sort((a, b) => new Date(b.request_date) - new Date(a.request_date));
        }

        // Calculate summary
        const summary = {
            total: finalTransactions.length,
            byType: {
                deposits: deposits.length,
                withdraws: withdraws.length,
                echecks: echecks.length,
                transfers: transfers.length,
                otherBankTransfers: otherBankTransfers.length,
                airTicketPayments: airTicketPayments.length
            },
            byStatus: finalTransactions.reduce((acc, curr) => {
                acc[curr.status] = (acc[curr.status] || 0) + 1;
                return acc;
            }, {})
        };

        // Prepare response data based on user role
        const responseData = {
            error: false,
            data: {
                transactions: finalTransactions,
                summary
            }
        };

        // Add branch and assigned_to based on user role
        if (!isBranchManagement) {
            if (isTellerOrMaker) {
                responseData.data.branch = user.branch;
                responseData.data.assigned_to = user.user;
            } else {
                responseData.data.branch = user.branch;
            }
        }

        res.status(200).json(responseData);

    } catch(e) {
        console.error("[BRANCH_TRANSACTIONS] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not retrieve transactions"
        });
    }
});





// ---------------------------------------------------------------------------
// Server-side aggregates for the Branch Record dashboard charts.
// This is a FAITHFUL port of the client-side computation that previously ran in
// src/views/admin/Branch_Record/stat.js (StatisticsTab) and BranchStat.js, so
// the charts render byte-identically — but it runs over light, projected docs
// on the server and returns only the small aggregates object, instead of
// shipping the entire transactions array (with base64 images) to the browser.
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const computeBranchStats = (transactions, branchCode) => {
    let incomingMoney = 0;
    let outgoingMoney = 0;
    let totalAmount = 0;
    let maxAmount = 0;
    let minAmount = Infinity;
    const transactionTypes = {};
    const statusDistribution = {};
    const postedByDistribution = {};
    const userStats = {};
    const delayMetrics = {};
    const waitingTimes = [];
    const hourSlots = {};
    const dayCounts = {};

    transactions.forEach((tx) => {
        const amount = parseFloat(tx.amount_in_figures) || 0;
        const type = tx.transactionType ? tx.transactionType.toLowerCase() : undefined;
        const status = tx.status || 'unknown';
        const postedBy = tx.posted_by || 'Unassigned';
        const beneficiaryBranch = tx.beneficiary_branch || '';

        transactionTypes[type] = (transactionTypes[type] || 0) + 1;
        statusDistribution[status] = (statusDistribution[status] || 0) + 1;
        postedByDistribution[postedBy] = (postedByDistribution[postedBy] || 0) + 1;

        // Money classification (identical type-string checks as the client).
        if (type === 'deposit') {
            incomingMoney += amount;
        } else if (type === 'withdraw' || type === 'other-bank-transfer') {
            outgoingMoney += amount;
        } else if (type === 'transfer') {
            if (beneficiaryBranch === branchCode) incomingMoney += amount;
            else outgoingMoney += amount;
        }

        // Amount stats (BranchStat).
        totalAmount += amount;
        if (amount > maxAmount) maxAmount = amount;
        if (amount < minAmount) minAmount = amount;

        // Per-user stats.
        if (!userStats[postedBy]) userStats[postedBy] = { incomingMoney: 0, outgoingMoney: 0, count: 0 };
        userStats[postedBy].count += 1;
        if (type === 'deposit' || (type === 'transfer' && beneficiaryBranch === branchCode)) {
            userStats[postedBy].incomingMoney += amount;
        } else if (type === 'withdraw' || type === 'other-bank-transfer' || (type === 'transfer' && beneficiaryBranch !== branchCode)) {
            userStats[postedBy].outgoingMoney += amount;
        }

        // Posting delay per user (posted_date - assigned_date), minutes.
        if (tx.assigned_date && tx.posted_date) {
            const delayMin = (new Date(tx.posted_date) - new Date(tx.assigned_date)) / 60000;
            if (!isNaN(delayMin) && delayMin >= 0) {
                if (!delayMetrics[postedBy]) {
                    delayMetrics[postedBy] = { max: delayMin, min: delayMin, total: delayMin, count: 1 };
                } else {
                    delayMetrics[postedBy].max = Math.max(delayMetrics[postedBy].max, delayMin);
                    delayMetrics[postedBy].min = Math.min(delayMetrics[postedBy].min, delayMin);
                    delayMetrics[postedBy].total += delayMin;
                    delayMetrics[postedBy].count += 1;
                }
            }
        }

        // Waiting time (request_date -> assigned_date), rounded minutes (BranchStat).
        if (tx.request_date && tx.assigned_date) {
            const diffMin = Math.round((new Date(tx.assigned_date) - new Date(tx.request_date)) / 60000);
            if (!isNaN(diffMin) && diffMin >= 0) waitingTimes.push(diffMin);
        }

        // Busy hours (2-hour windows) + busy days (BranchStat).
        if (tx.request_date) {
            const d = new Date(tx.request_date);
            const hour = d.getHours();
            const slotStart = Math.floor(hour / 2) * 2;
            const slotEnd = slotStart + 2;
            const label = `${String(slotStart).padStart(2, '0')}:00 - ${String(slotEnd).padStart(2, '0')}:00`;
            hourSlots[label] = (hourSlots[label] || 0) + 1;
            const day = WEEKDAYS[d.getDay()];
            if (day) dayCounts[day] = (dayCounts[day] || 0) + 1;
        }
    });

    // Per-user average delay (return only what the charts read: min/avg/max).
    const delayMetricsOut = {};
    Object.entries(delayMetrics).forEach(([user, m]) => {
        delayMetricsOut[user] = { min: m.min, max: m.max, avg: m.total / m.count };
    });

    const totalTransactions = transactions.length;
    if (minAmount === Infinity) minAmount = 0;

    // Waiting-time summary (BranchStat waitStats: avg is toFixed(1) string in the client).
    let waitStats = { min: 0, max: 0, avg: 0 };
    if (waitingTimes.length > 0) {
        waitStats = {
            min: Math.min(...waitingTimes),
            max: Math.max(...waitingTimes),
            avg: (waitingTimes.reduce((a, b) => a + b, 0) / waitingTimes.length).toFixed(1),
        };
    }

    return {
        // StatisticsTab
        incomingMoney, outgoingMoney, netFlow: incomingMoney - outgoingMoney,
        transactionTypes, statusDistribution, postedByDistribution,
        userStats, delayMetrics: delayMetricsOut, totalTransactions,
        // BranchStat
        totalAmount, maxAmount, minAmount,
        avgAmount: totalTransactions > 0 ? totalAmount / totalTransactions : 0,
        incomingAmount: incomingMoney, outgoingAmount: outgoingMoney,
        typeCounts: transactionTypes, statusCounts: statusDistribution,
        hourSlots, dayCounts, waitStats,
    };
};

// Lightweight fields needed for the aggregates (NO base64 images / heavy fields).
const STATS_PROJECTION = {
    amount_in_figures: 1, status: 1, posted_by: 1, beneficiary_branch: 1,
    assigned_date: 1, posted_date: 1, request_date: 1,
};

router.get("/branch_transactions_stats", auth, async (req, res, next) => {
    try {
        const user = await User.findById(req.user._id).lean();
        if (!user) {
            return res.status(400).json({ error: true, message: "User not found" });
        }

        const isTellerOrMaker = req.user.roles.includes('Teller') || req.user.roles.includes('Maker');
        const isBranchManagement = req.user.roles.includes('Branch_Management');
        const queryCondition = isBranchManagement ? {} : (isTellerOrMaker ? { assigned_to: user.user } : { branch: user.branch });
        // Match the client: branchCode was '' for Branch_Management (the old endpoint
        // never set data.branch for that role), else the user's branch.
        const branchCode = isBranchManagement ? '' : user.branch;

        // Optional date-range filter (same inclusive window the client used).
        const { from, to } = req.query;
        const filter = { ...queryCondition };
        if (from || to) {
            filter.request_date = {};
            if (from) filter.request_date.$gte = new Date(from);
            if (to) filter.request_date.$lte = new Date(`${to}T23:59:59`);
        }

        const models = [
            [Deposit, 'deposit'], [Withdraw, 'withdraw'], [ECheck, 'echeck'],
            [Transfer, 'transfer'], [Other_Bank_Transfer, 'other_bank_transfer'],
            [Air_Ticket_Payment, 'air_ticket_payment'],
        ];
        const results = await Promise.all(
            models.map(([Model]) => Model.find(filter, STATS_PROJECTION).lean())
        );
        const transactions = [];
        results.forEach((rows, i) => {
            const transactionType = models[i][1];
            for (const r of rows) transactions.push({ ...r, transactionType });
        });

        const stats = computeBranchStats(transactions, branchCode);
        res.status(200).json({ error: false, data: stats });
    } catch (e) {
        console.error("[BRANCH_TRANSACTIONS_STATS] Error:", e.message);
        res.status(500).json({ error: true, message: "Could not compute statistics" });
    }
});

router.get("/till_id", auth, roleCheck(["Admin"]), async(req, res, next) => {
    try {
        // Get current user
        const user = await User.findById(req.user._id).lean();
        if (!user) {
            return res.status(400).json({ error: true, message: "User not found" });
        }

        // Query to get till IDs for user's branch
        const tillQuery = `
            SELECT DISTINCT TILL_ID 
            FROM fcubsprd.smtb_user_tills 
            WHERE branch_code = :1
        `;

        const tillResult = await executeQuery(
            tillQuery,
            [user.branch]
        );

       

        res.status(200).json({
            error: false,
            data: tillResult.data
        });

    } catch(e) {
        console.error("[TILL_ID] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not retrieve till IDs"
        });
    }
})




router.post("/add_teller", auth, roleCheck(["Admin"]), async(req, res, next) => {
    try {
        const { till_id, user, email, role } = req.body;

        if (!role || !['Teller', 'Authorizer', 'Auditor', 'Maker', 'Admin'].includes(role)) {
            return res.status(400).json({ 
                error: true, 
                message: "Invalid or missing role" 
            });
        }

        const existingUser = await User.findOne({ user });
        if (existingUser) {
            return res.status(400).json({ error: true, message: "User already exists" });
        }

        const branchManager = await User.findById(req.user._id).lean();
        if (!branchManager) {
            return res.status(400).json({ error: true, message: "Branch manager not found" });
        }

        // Split username into parts
        const [firstName, lastName] = user.split('.');
        const firstNameUpper = firstName.toUpperCase();
        let flexId = '';

        if (role === 'Teller') {
            // Existing Teller logic
            if (!till_id) {
                return res.status(400).json({ 
                    error: true, 
                    message: "Till ID is required for Teller role" 
                });
            }

            const userQuery = `
                SELECT USER_ID 
                FROM fcubsprd.smtb_user_tills 
                WHERE TILL_ID = :1
            `;

            const userResults = await executeQuery(userQuery, [till_id]);
            
            const matchingIds = userResults.data.filter(u => 
                u.USER_ID.startsWith(firstNameUpper)
            );

            if (matchingIds.length === 0) {
                return res.status(400).json({ 
                    error: true, 
                    message: "No matching flex_id found for this till_id" 
                });
            }

            if (matchingIds.length === 1) {
                flexId = matchingIds[0].USER_ID;
            } else {
                const lastNameParts = lastName.toUpperCase().split('_');
                let found = false;
                
                for (let i = 1; i <= lastNameParts.length && !found; i++) {
                    const nameToMatch = firstNameUpper + lastNameParts.slice(0,i).join('');
                    const exactMatch = matchingIds.find(u => u.USER_ID === nameToMatch);
                    if (exactMatch) {
                        flexId = exactMatch.USER_ID;
                        found = true;
                    }
                }

                if (!found) {
                    flexId = matchingIds[0].USER_ID;
                }
            }
        } else if(role === 'Authorizer') {
            // Logic for Authorizer and Auditor
            const userQuery = `
                SELECT DISTINCT USER_ID 
                FROM fcubsprd.smtb_user_role 
                WHERE BRANCH_CODE = :1 
                AND USER_ID LIKE :2 || '%'
            `;

            const userResults = await executeQuery(userQuery, [
                branchManager.branch,
                firstNameUpper
            ]);

            if (!userResults.data || userResults.data.length === 0) {
                return res.status(400).json({ 
                    error: true, 
                    message: `No matching user found in branch ${branchManager.branch} for ${role} role` 
                });
            }

            // Try to find exact match or closest match
            const matchingIds = userResults.data;
            if (matchingIds.length === 1) {
                flexId = matchingIds[0].USER_ID;
            } else {
                const lastNameParts = lastName.toUpperCase().split('_');
                let found = false;
                
                for (let i = 1; i <= lastNameParts.length && !found; i++) {
                    const nameToMatch = firstNameUpper + lastNameParts.slice(0,i).join('');
                    const exactMatch = matchingIds.find(u => u.USER_ID === nameToMatch);
                    if (exactMatch) {
                        flexId = exactMatch.USER_ID;
                        found = true;
                    }
                }

                if (!found) {
                    flexId = matchingIds[0].USER_ID;
                }
            }
        }
       
        // Create new user with appropriate fields
        const newUser = new User({
            user,
            branch: branchManager.branch,
            roles: [role],
            email,
            ...(role === 'Teller' && { till_id }), // Only include till_id for Tellers
            ...((role === 'Teller' || role === 'Authorizer') && { flex_id: flexId})
          //  flex_id: flexId
        });

        await newUser.save();

        res.status(200).json({ 
            error: false, 
            message: `${role} added successfully`,
            data: {
                user,
                flex_id: flexId,
                branch: branchManager.branch
            }
        });

    } catch(e) {
        console.error("[ADD_TELLER] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not perform the operation"
        });
    }
});





// router.post("/add_teller", auth, roleCheck(["Admin"]), async(req, res, next) => {
//     try {
//         console.log("req.body", req.body)
        
//         const { till_id, domain_user, email } = req.body;

//         const user = await User.findOne({ domain_user });
//         if (user) {
//             return res.status(400).json({ error: true, message: "User already exists" });
//         }

//         const branchManeger = await User.findById(req.user._id).lean();
//         if (!branchManeger) {
//             return res.status(400).json({ error: true, message: "branchManeger not found" });
//         }

//         // Split domain username into parts
//         const [firstName, lastName] = domain_user.split('.');
        
//         // Query to get user IDs for the till
//         const userQuery = `
//             SELECT USER_ID 
//             FROM fcubsprd.smtb_user_tills 
//             WHERE TILL_ID = :1
//         `;

//         const userResults = await executeQuery(userQuery, [till_id]);

//         console.log("userResults", userResults)

//         // Find matching user ID from query results
//         let flexId = '';
//         const firstNameUpper = firstName.toUpperCase();
        
//         // Try to find user ID starting with first name
//         const matchingIds = userResults.data.filter(u => 
//             u.USER_ID.startsWith(firstNameUpper)
//         );

//         if (matchingIds.length === 0) {
//             return res.status(400).json({ 
//                 error: true, 
//                 message: "The flex_id cannot get from that till_id" 
//             });
//         }

//         if (matchingIds.length === 1) {
//             // Found single match starting with first name
//             flexId = matchingIds[0].USER_ID;
//         } else {
//             // Multiple matches - try adding father's name parts
//             const lastNameParts = lastName.toUpperCase().split('_');
//             let found = false;
            
//             for (let i = 1; i <= lastNameParts.length && !found; i++) {
//                 const nameToMatch = firstNameUpper + lastNameParts.slice(0,i).join('');
//                 const exactMatch = matchingIds.find(u => u.USER_ID === nameToMatch);
//                 if (exactMatch) {
//                     flexId = exactMatch.USER_ID;
//                     found = true;
//                 }
//             }

//             if (!found) {
//                 // No exact match found - use first matching ID
//                 flexId = matchingIds[0].USER_ID;
//             }
//         }

//         const newUser = new User({
//             domain_user: domain_user,
//             branch: branchManeger.branch,
//             roles: ["Teller"],
//             email: email,
//             till_id: till_id,
//             flex_id: flexId
//         });

//         await newUser.save();

//         res.status(200).json({ error: false, message: "Teller added successfully" });

//     } catch(e) {
//         console.log("Error", e);
//         res.status(500).json({ 
//             error: true, 
//             message: e.message || "Could not perform the operation" 
//         });
//     }
// })



router.get("/get_users_per_branch", auth, roleCheck(["Admin"]), async(req, res, next) => {
    try {
        const sendUsers = {
            data: {}
        };
        const meta = {};
        const branchManager = await User.findById(req.user._id).lean();
        if (!branchManager) {
            return res.status(400).json({ error: true, message: "Branch manager not found" });
        }

        const filter = { branch: branchManager.branch };
        // Project only the fields the response actually returns — avoids loading
        // the password hash and any other unused fields into memory / off the wire.
        const projection = { user: 1, email: 1, roles: 1, till_id: 1, branch: 1, flex_id: 1, created_at: 1 };

        // OPT-IN, backward-compatible server-side pagination. With no start/size
        // the full branch list is returned exactly as before (totalRowCount =
        // list length). With both, one page is returned plus the true total so a
        // material-react-table grid can switch to manualPagination when ready.
        const { start, size } = req.query;
        const hasPagination = start !== undefined && size !== undefined;

        let query = User.find(filter, projection).lean();
        if (hasPagination) {
            query = query.skip(Number(start)).limit(Number(size));
        }
        const users = await query;

        const totalRowCount = hasPagination
            ? await User.countDocuments(filter)
            : users.length;

        // Diagnostic: shows which admin/branch was resolved and how many users matched.
        console.log(
            `[get_users_per_branch] admin=${branchManager.user} branch=${JSON.stringify(branchManager.branch)} -> ${totalRowCount} user(s)${hasPagination ? ` (page start=${start} size=${size})` : ''}`
        );

        // Map users similar to getUsers endpoint
        sendUsers.data = users.map((user) => ({
            id: user._id.toString(),
            user: user.user,
            email: user.email,
            roles: user.roles[0],
            till_id: user.till_id,
            branch: user.branch,
            flex_id: user.flex_id,
            created_at: user.created_at,

        }));

        meta.totalRowCount = totalRowCount;
        sendUsers.meta = meta;
        res.json(sendUsers);

    } catch(e) {
        console.error("[GET_USERS] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not perform the operation"
        });
    }
});


async function getActiveTellerforTheBranch(branch){
    try{

        const activeTellersQuery = `
        SELECT USER_ID 
        FROM fcubsprd.fbtb_till_master_tb 
        WHERE branch_code = :1
    `;

    const activeTellersResult = await executeQuery(activeTellersQuery, [branch]);
    
    if (!activeTellersResult.success || !activeTellersResult.data?.length) {
        throw new Error("No active tellers found in branch");
    }

    // Get flex_ids of active tellers
    const activeFlexIds = activeTellersResult.data.map(row => row.USER_ID);

    // Find matching tellers in MongoDB
    const tellers = await User.find({
        branch: branch,
        roles: "Teller",
        flex_id: { $in: activeFlexIds }
    }).lean();

    if (!tellers || tellers.length === 0) {
        throw new Error("No matching tellers found in system");
    }

    return tellers;

    }

    catch (error) {
        console.error("[ASSIGN_TELLER_BY_SYSTEM] Error:", error.message);
        throw error;
    }

}


async function assignTellerBySystem(branch) {
    try {
        // First get active teller IDs from Oracle
        const activeTellersQuery = `
            SELECT USER_ID 
            FROM fcubsprd.fbtb_till_master_tb 
            WHERE branch_code = :1
        `;

        const activeTellersResult = await executeQuery(activeTellersQuery, [branch]);
        
        if (!activeTellersResult.success || !activeTellersResult.data?.length) {
            throw new Error("No active tellers found in branch");
        }

        // Get flex_ids of active tellers
        const activeFlexIds = activeTellersResult.data.map(row => row.USER_ID);

        // Find matching tellers in MongoDB
        const tellers = await User.find({
            branch: branch,
            roles: "Teller",
            flex_id: { $in: activeFlexIds }
        }).lean();

        if (!tellers || tellers.length === 0) {
            throw new Error("No matching tellers found in system");
        }

        // Get today's assignments count for each teller
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        
        const assignmentCounts = await Promise.all(tellers.map(async teller => {
            const count = await Promise.all([
                Deposit.countDocuments({
                    branch: branch,
                    assigned_to: teller.user,
                    assigned_date: { $gte: today }
                }),
                Withdraw.countDocuments({
                    branch: branch,
                    assigned_to: teller.user,
                    assigned_date: { $gte: today }
                }),
                Transfer.countDocuments({
                    branch: branch,
                    assigned_to: teller.user,
                    assigned_date: { $gte: today }
                }),
                Other_Bank_Transfer.countDocuments({
                    branch: branch,
                    assigned_to: teller.user,
                    assigned_date: { $gte: today }
                }),
                Air_Ticket_Payment.countDocuments({
                    branch: branch,
                    assigned_to: teller.user,
                    assigned_date: { $gte: today }
                })
            ]);

            return {
                teller,
                totalAssignments: count.reduce((a, b) => a + b, 0)
            };
        }));

        // Sort tellers by assignment count and get the one with least assignments
        const selectedTeller = assignmentCounts.sort((a, b) => 
            a.totalAssignments - b.totalAssignments
        )[0].teller;

        return {
            assigned_by: "system",
            branch: branch,
            assigned_to: selectedTeller.user,
            assigned_date: new Date().toISOString(),
            status: 'assigned'
        };
    } catch (error) {
        console.error("[ASSIGN_TELLER_BY_SYSTEM] Error:", error.message);
        throw error;
    }
}


// =====================================================
// BIOMETRIC REGISTRATION ROUTES
// =====================================================

// Register new biometric (Teller/Maker)
// Helper function to check if a template is simulated
function isSimulatedTemplate(base64Template) {
    if (!base64Template) return false;
    try {
        const decoded = Buffer.from(base64Template, 'base64').toString('utf-8');
        return decoded.includes('ZK9500_SIMULATED') ||
               (decoded.includes('"type"') && decoded.includes('"version"') && decoded.startsWith('{'));
    } catch {
        return false;
    }
}

router.post("/biometric/register", auth, roleCheck(["Teller", "Maker"]), async (req, res) => {
    try {
        const { cif, fingerprint_template, finger_position, customer_name, account_number, allow_simulated } = req.body;

        // Validate CIF is 7 digits
        if (!cif || !/^\d{7}$/.test(cif)) {
            return res.status(400).json({
                error: true,
                message: "CIF must be a 7-digit number"
            });
        }

        // Validate fingerprint template
        if (!fingerprint_template) {
            return res.status(400).json({
                error: true,
                message: "Fingerprint template is required"
            });
        }

        // Check if template is simulated (fake)
        const isSimulated = isSimulatedTemplate(fingerprint_template);
        if (isSimulated && !allow_simulated) {
            return res.status(400).json({
                error: true,
                message: "SIMULATED TEMPLATE DETECTED: The fingerprint scanner may not be connected or SDK is not working. Please ensure the ZK9500 scanner is connected and try again. Set allow_simulated=true to override (not recommended for production).",
                simulated: true
            });
        }

        // Get current user
        const user = await User.findById(req.user._id).lean();

        // Check if biometric already exists for this CIF with approved status
        const existingBiometric = await Biometric.findOne({
            cif: cif,
            status: 'approved'
        });

        if (existingBiometric) {
            return res.status(400).json({
                error: true,
                message: "Biometric already registered and approved for this CIF"
            });
        }

        // Check if there's a pending registration for this CIF
        const pendingBiometric = await Biometric.findOne({
            cif: cif,
            status: 'pending'
        });

        if (pendingBiometric) {
            return res.status(400).json({
                error: true,
                message: "There is already a pending biometric registration for this CIF"
            });
        }

        // Create new biometric registration
        const newBiometric = new Biometric({
            cif,
            fingerprint_template,
            finger_position: finger_position || 'right_index',
            status: 'pending',
            branch: user.branch,
            registered_by: user.user,
            registered_by_id: user._id,
            customer_name: customer_name || '',
            account_number: account_number || '',
            registration_date: new Date(),
            is_simulated: isSimulated // Track if template is simulated
        });

        await newBiometric.save();

        const message = isSimulated
            ? "WARNING: Biometric registered with SIMULATED template. This will NOT work for real authentication. Re-register with scanner connected."
            : "Biometric registration submitted successfully. Pending admin approval.";

        console.log(`[BIOMETRIC_REGISTER] Biometric registered - Simulated: ${isSimulated}`);

        res.status(201).json({
            error: false,
            message: message,
            data: {
                id: newBiometric._id,
                cif: newBiometric.cif,
                status: newBiometric.status,
                registration_date: newBiometric.registration_date,
                simulated: isSimulated
            }
        });

    } catch (e) {
        console.error("[BIOMETRIC_REGISTER] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not register biometric"
        });
    }
});

// Get biometrics registered by current user (Teller view)
router.get("/biometric/my_registrations", auth, roleCheck(["Teller", "Maker"]), async (req, res) => {
    try {
        const user = await User.findById(req.user._id).lean();

        const biometrics = await Biometric.find({
            registered_by_id: user._id
        }).sort({ registration_date: -1 }).lean();

        res.status(200).json({
            error: false,
            data: biometrics
        });

    } catch (e) {
        console.error("[BIOMETRIC_MY_REGISTRATIONS] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not fetch biometrics"
        });
    }
});

// Get all biometrics for admin's branch (Admin view)
router.get("/biometric/branch_registrations", auth, roleCheck(["Admin"]), async (req, res) => {
    try {
        const user = await User.findById(req.user._id).lean();

        const biometrics = await Biometric.find({
            branch: user.branch
        }).sort({ registration_date: -1 }).lean();

        res.status(200).json({
            error: false,
            data: biometrics
        });

    } catch (e) {
        console.error("[BIOMETRIC_BRANCH_REGISTRATIONS] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not fetch branch biometrics"
        });
    }
});

// Get pending biometrics for admin's branch (Admin approval queue)
router.get("/biometric/pending_approvals", auth, roleCheck(["Admin"]), async (req, res) => {
    try {
        const user = await User.findById(req.user._id).lean();

        const biometrics = await Biometric.find({
            branch: user.branch,
            status: 'pending'
        }).sort({ registration_date: -1 }).lean();

        res.status(200).json({
            error: false,
            data: biometrics
        });

    } catch (e) {
        console.error("[BIOMETRIC_PENDING_APPROVALS] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not fetch pending biometrics"
        });
    }
});

// Approve biometric registration (Admin)
router.post("/biometric/approve", auth, roleCheck(["Admin"]), async (req, res) => {
    try {
        const { biometric_id } = req.body;

        if (!biometric_id) {
            return res.status(400).json({
                error: true,
                message: "Biometric ID is required"
            });
        }

        const user = await User.findById(req.user._id).lean();

        // Find the biometric record
        const biometric = await Biometric.findById(biometric_id);

        if (!biometric) {
            return res.status(404).json({
                error: true,
                message: "Biometric record not found"
            });
        }

        // Check if biometric is from same branch
        if (biometric.branch !== user.branch) {
            return res.status(403).json({
                error: true,
                message: "You can only approve biometrics from your branch"
            });
        }

        // Check if already processed
        if (biometric.status !== 'pending') {
            return res.status(400).json({
                error: true,
                message: `Biometric is already ${biometric.status}`
            });
        }

        // Update biometric status
        biometric.status = 'approved';
        biometric.approved_by = user.user;
        biometric.approved_by_id = user._id;
        biometric.approval_date = new Date();

        await biometric.save();

        res.status(200).json({
            error: false,
            message: "Biometric approved successfully",
            data: {
                id: biometric._id,
                cif: biometric.cif,
                status: biometric.status,
                approval_date: biometric.approval_date
            }
        });

    } catch (e) {
        console.error("[BIOMETRIC_APPROVE] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not approve biometric"
        });
    }
});

// Reject biometric registration (Admin)
router.post("/biometric/reject", auth, roleCheck(["Admin"]), async (req, res) => {
    try {
        const { biometric_id, rejection_reason } = req.body;

        if (!biometric_id) {
            return res.status(400).json({
                error: true,
                message: "Biometric ID is required"
            });
        }

        const user = await User.findById(req.user._id).lean();

        // Find the biometric record
        const biometric = await Biometric.findById(biometric_id);

        if (!biometric) {
            return res.status(404).json({
                error: true,
                message: "Biometric record not found"
            });
        }

        // Check if biometric is from same branch
        if (biometric.branch !== user.branch) {
            return res.status(403).json({
                error: true,
                message: "You can only reject biometrics from your branch"
            });
        }

        // Check if already processed
        if (biometric.status !== 'pending') {
            return res.status(400).json({
                error: true,
                message: `Biometric is already ${biometric.status}`
            });
        }

        // Update biometric status
        biometric.status = 'rejected';
        biometric.approved_by = user.user;
        biometric.approved_by_id = user._id;
        biometric.approval_date = new Date();
        biometric.rejection_reason = rejection_reason || '';

        await biometric.save();

        res.status(200).json({
            error: false,
            message: "Biometric rejected",
            data: {
                id: biometric._id,
                cif: biometric.cif,
                status: biometric.status
            }
        });

    } catch (e) {
        console.error("[BIOMETRIC_REJECT] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not reject biometric"
        });
    }
});

// Verify biometric by CIF (for login/authentication)
router.post("/biometric/verify", auth, async (req, res) => {
    try {
        const { cif, fingerprint_template } = req.body;

        if (!cif || !fingerprint_template) {
            return res.status(400).json({
                error: true,
                message: "CIF and fingerprint template are required"
            });
        }

        // Find approved biometric for this CIF
        const biometric = await Biometric.findOne({
            cif: cif,
            status: 'approved'
        }).lean();

        if (!biometric) {
            return res.status(404).json({
                error: false,
                verified: false,
                message: "No approved biometric found for this CIF"
            });
        }

        // In a real implementation, you would compare fingerprint templates
        // using a fingerprint matching library/service
        // For now, we'll do a simple string comparison
        const isMatch = biometric.fingerprint_template === fingerprint_template;

        res.status(200).json({
            error: false,
            verified: isMatch,
            message: isMatch ? "Biometric verified successfully" : "Fingerprint does not match",
            data: isMatch ? {
                cif: biometric.cif,
                customer_name: biometric.customer_name,
                account_number: biometric.account_number
            } : null
        });

    } catch (e) {
        console.error("[BIOMETRIC_VERIFY] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not verify biometric"
        });
    }
});

// Get biometric by CIF (check if exists)
router.get("/biometric/check/:cif", auth, async (req, res) => {
    try {
        const { cif } = req.params;

        if (!cif || !/^\d{7}$/.test(cif)) {
            return res.status(400).json({
                error: true,
                message: "Valid 7-digit CIF is required"
            });
        }

        const biometric = await Biometric.findOne({
            cif: cif
        }).select('cif status customer_name registration_date approval_date').lean();

        res.status(200).json({
            error: false,
            exists: !!biometric,
            data: biometric
        });

    } catch (e) {
        console.error("[BIOMETRIC_CHECK] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not check biometric"
        });
    }
});






// Get customer info by CIF from Oracle Flexcube
router.get("/biometric/customer/:cif", auth, roleCheck(["Teller", "Maker"]), async (req, res) => {
    try {
        const { cif } = req.params;

        if (!cif || !/^\d{7}$/.test(cif)) {
            return res.status(400).json({
                error: true,
                message: "Valid 7-digit CIF is required"
            });
        }

        const customerQuery = `
            SELECT CUSTOMER_NO, CUSTOMER_NAME1
            FROM FCUBSPRD.STTM_CUSTOMER
            WHERE CUSTOMER_NO = :1
        `;

        const customerResult = await executeQuery(customerQuery, [cif]);

        if (!customerResult.success) {
            return res.status(500).json({
                error: true,
                message: "Failed to query customer database"
            });
        }

        if (!customerResult.data || customerResult.data.length === 0) {
            return res.status(404).json({
                error: true,
                found: false,
                message: "Customer not found with this CIF"
            });
        }

        const customer = customerResult.data[0];

        res.status(200).json({
            error: false,
            found: true,
            data: {
                cif: customer.CUSTOMER_NO,
                customer_name: customer.CUSTOMER_NAME1
            }
        });

    } catch (e) {
        console.error("[BIOMETRIC_CUSTOMER] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Could not fetch customer information"
        });
    }
});


// Fingerprint authentication for customer-facing app
// Uses ZK SDK's fast 1:N DBIdentify for efficient matching (~50,000+ templates/second)
router.post("/biometric/authenticate", async (req, res) => {
    try {
        const { fingerprint_template, cif: requestedCif, encryptedToken } = req.body;

        if (!fingerprint_template) {
            return res.status(400).json({
                error: true,
                message: "Fingerprint template is required"
            });
        }

        // Derive CIF from encrypted token if provided (name/phone search flow)
        let cifToUse = requestedCif;
        if (encryptedToken && !requestedCif) {
            try {
                const accountNumber = decryptAccountToken(encryptedToken);
                cifToUse = extractCIF(accountNumber);
            } catch (err) {
                return res.status(400).json({
                    error: true,
                    message: "Invalid or expired account token"
                });
            }
        }

        // Get all approved biometrics (or just the specific CIF if provided)
        const query = { status: 'approved' };
        if (cifToUse) {
            query.cif = cifToUse;
        }
        const approvedBiometrics = await Biometric.find(query);

        if (approvedBiometrics.length === 0) {
            return res.status(404).json({
                error: true,
                message: "No registered fingerprints found"
            });
        }

        // Use fast 1:N identification instead of looping through 1:1 verifications
        let matchedBiometric = null;
        let matchScore = 0;

        let isSimulatedMatch = false;

        try {
            const identifyResult = await identifyFingerprint(fingerprint_template, approvedBiometrics);

            if (identifyResult.success && identifyResult.found && identifyResult.cif) {
                // Find the matched biometric record
                matchedBiometric = approvedBiometrics.find(b => b.cif === identifyResult.cif);
                matchScore = identifyResult.score || 0;
                isSimulatedMatch = identifyResult.simulated || false;
            } else if (!identifyResult.success) {
                // SDK failed, fall back to 1:1 verification
                throw new Error(identifyResult.message || 'SDK identify failed');
            }
        } catch (identifyError) {
            console.error('[BIOMETRIC_AUTHENTICATE] Fast identification failed, falling back to 1:1 verification:', identifyError.message);

            // Fallback to 1:1 verification loop if fast identification fails
            for (const biometric of approvedBiometrics) {
                try {
                    const verifyResult = await verifyFingerprint(fingerprint_template, biometric.fingerprint_template);
                    if (verifyResult.success && verifyResult.match && verifyResult.score > matchScore) {
                        matchedBiometric = biometric;
                        matchScore = verifyResult.score;
                        isSimulatedMatch = verifyResult.simulated || false;
                        break;
                    }
                } catch (verifyError) {
                    console.error('[BIOMETRIC_AUTHENTICATE] Verify error:', verifyError.message);
                }
            }
        }

        if (!matchedBiometric) {
            return res.status(401).json({
                error: true,
                message: "Fingerprint not recognized. Please register your fingerprint at the branch."
            });
        }

        const cif = matchedBiometric.cif;

        // Get customer accounts from Flexcube
        const accountsQuery = `
            SELECT b.CUST_AC_NO, b.AC_DESC, b.CCY
            FROM FCUBSPRD.STTM_CUSTOMER a, FCUBSPRD.STTM_CUST_ACCOUNT b
            WHERE a.CUSTOMER_NO = b.CUST_NO
            AND a.CUSTOMER_NO = :1
        `;

        const accountsResult = await executeQuery(accountsQuery, [cif]);

        if (!accountsResult.success || !accountsResult.data || accountsResult.data.length === 0) {
            return res.status(404).json({
                error: true,
                message: "No accounts found for this customer"
            });
        }

        // Get customer name from Flexcube or use stored name
        let customerName = matchedBiometric.customer_name;
        try {
            const customerQuery = `
                SELECT CUSTOMER_NO, CUSTOMER_NAME1
                FROM FCUBSPRD.STTM_CUSTOMER
                WHERE CUSTOMER_NO = :1
            `;
            const customerResult = await executeQuery(customerQuery, [cif]);
            if (customerResult.success && customerResult.data && customerResult.data[0]) {
                customerName = customerResult.data[0].CUSTOMER_NAME1;
            }
        } catch (e) {
            console.log('Using stored customer name');
        }

        // Return matched customer info and accounts
        res.status(200).json({
            error: false,
            message: isSimulatedMatch
                ? "Fingerprint authenticated (simulation mode - not production safe)"
                : "Fingerprint authenticated successfully",
            data: {
                cif: cif,
                customer_name: customerName,
                finger_position: matchedBiometric.finger_position,
                match_score: matchScore,
                simulated: isSimulatedMatch,
                accounts: accountsResult.data.map(acc => ({
                    account_number: acc.CUST_AC_NO,
                    account_name: acc.AC_DESC,
                    currency: acc.CCY
                }))
            }
        });

    } catch (e) {
        console.error("[BIOMETRIC_AUTHENTICATE] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Authentication failed"
        });
    }
});


// ============================================
// DENOMINATION AND LIMIT MANAGEMENT ROUTES
// ============================================

/**
 * Auto-populate denomination based on amount
 * Uses greedy algorithm to minimize number of notes/coins
 */
router.post("/autopopulate-denomination", auth, async (req, res) => {
    try {
        const { amount } = req.body;

        if (!amount || isNaN(parseFloat(amount)) || parseFloat(amount) <= 0) {
            return res.status(400).json({
                error: true,
                message: "Valid positive amount is required"
            });
        }

        const denomination = FlexcubeTransactionService.autopopulateDenomination(parseFloat(amount));
        const total = FlexcubeTransactionService.calculateDenominationTotal(denomination);

        res.status(200).json({
            error: false,
            message: "Denomination calculated successfully",
            data: {
                denomination,
                total,
                difference: Math.abs(parseFloat(amount) - total)
            }
        });
    } catch (e) {
        console.error("[AUTOPOPULATE_DENOMINATION] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Failed to calculate denomination"
        });
    }
});

/**
 * Validate denomination matches amount
 */
router.post("/validate-denomination", auth, async (req, res) => {
    try {
        const { amount, denomination } = req.body;

        if (!amount || !denomination) {
            return res.status(400).json({
                error: true,
                message: "Amount and denomination are required"
            });
        }

        const total = FlexcubeTransactionService.calculateDenominationTotal(denomination);
        const parsedAmount = parseFloat(amount);
        const isValid = Math.abs(total - parsedAmount) < 0.01; // Allow tiny rounding difference

        res.status(200).json({
            error: false,
            message: isValid ? "Denomination is valid" : "Denomination does not match amount",
            data: {
                isValid,
                denominationTotal: total,
                expectedAmount: parsedAmount,
                difference: Math.abs(total - parsedAmount)
            }
        });
    } catch (e) {
        console.error("[VALIDATE_DENOMINATION] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Failed to validate denomination"
        });
    }
});

/**
 * Check withdrawal limit for a customer
 * Returns limit info and whether transaction can proceed
 */
router.post("/check-withdrawal-limit", auth, async (req, res) => {
    try {
        const { account_number, amount } = req.body;

        if (!account_number || !amount) {
            return res.status(400).json({
                error: true,
                message: "Account number and amount are required"
            });
        }

        const limitCheck = await FlexcubeTransactionService.checkWithdrawalLimit(
            account_number,
            parseFloat(amount)
        );

        res.status(200).json({
            error: false,
            message: limitCheck.allowed
                ? "Withdrawal is within limits"
                : `Withdrawal exceeds daily limit: ${limitCheck.reason}`,
            data: limitCheck
        });
    } catch (e) {
        console.error("[CHECK_WITHDRAWAL_LIMIT] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Failed to check withdrawal limit"
        });
    }
});

/**
 * Check if amount requires maker-checker approval
 */
router.post("/check-maker-checker", auth, async (req, res) => {
    try {
        const { amount, currency = 'ETB' } = req.body;

        if (!amount) {
            return res.status(400).json({
                error: true,
                message: "Amount is required"
            });
        }

        const checkerCheck = await FlexcubeTransactionService.checkMakerCheckerThreshold(
            parseFloat(amount),
            currency
        );

        res.status(200).json({
            error: false,
            message: checkerCheck.needsChecker
                ? `Amount ${amount} requires checker approval (threshold: ${checkerCheck.threshold})`
                : "No checker approval required",
            data: checkerCheck
        });
    } catch (e) {
        console.error("[CHECK_MAKER_CHECKER] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Failed to check maker-checker threshold"
        });
    }
});

/**
 * Process withdraw transaction with denomination (Teller posting)
 * This handles the full withdrawal workflow including limit checks, denomination validation,
 * maker-checker threshold, Flexcube SOAP transaction, and till updates
 */
router.post("/process-withdraw-with-denomination", auth, async (req, res) => {
    try {
        const {
            withdraw_id,
            denomination,
            trn_ref_no,
            posted_by,
            remarks
        } = req.body;

        if (!withdraw_id) {
            return res.status(400).json({
                error: true,
                message: "Withdraw ID is required"
            });
        }

        // Find the withdraw request
        const withdraw = await Withdraw.findById(withdraw_id);
        if (!withdraw) {
            return res.status(404).json({
                error: true,
                message: "Withdraw request not found"
            });
        }

        // Validate status
        if (!['assigned', 'assigned_by_csr'].includes(withdraw.status)) {
            return res.status(400).json({
                error: true,
                message: `Cannot process withdraw with status: ${withdraw.status}`
            });
        }

        const amount = parseFloat(withdraw.amount_in_figures);

        // If denomination provided, validate it
        let finalDenomination = denomination;
        if (denomination) {
            const denomTotal = FlexcubeTransactionService.calculateDenominationTotal(denomination);
            if (Math.abs(denomTotal - amount) > 0.01) {
                return res.status(400).json({
                    error: true,
                    message: `Denomination total (${denomTotal}) does not match amount (${amount})`
                });
            }
        } else {
            // Auto-populate denomination if not provided
            finalDenomination = FlexcubeTransactionService.autopopulateDenomination(amount);
        }

        // Check withdrawal limit
        const limitCheck = await FlexcubeTransactionService.checkWithdrawalLimit(
            withdraw.account_number,
            amount
        );

        if (!limitCheck.allowed) {
            // Reject the transaction
            withdraw.status = 'rejected';
            withdraw.rejection_reason = limitCheck.reason;
            withdraw.limit_check_passed = false;
            withdraw.daily_limit = limitCheck.dailyLimit;
            withdraw.daily_withdrawn_before = limitCheck.alreadyWithdrawn;
            withdraw.customer_category = limitCheck.customerCategory;
            await withdraw.save();

            return res.status(400).json({
                error: true,
                message: `Withdrawal rejected: ${limitCheck.reason}`,
                data: {
                    limitCheck,
                    status: 'rejected'
                }
            });
        }

        // Check maker-checker threshold
        const checkerCheck = await FlexcubeTransactionService.checkMakerCheckerThreshold(amount);

        // Generate XREF if not exists
        if (!withdraw.xref) {
            withdraw.xref = await Withdraw.generateXref();
        }

        // Update withdraw with limit and denomination info
        withdraw.denomination = finalDenomination;
        withdraw.denomination_total = FlexcubeTransactionService.calculateDenominationTotal(finalDenomination);
        withdraw.limit_check_passed = true;
        withdraw.daily_limit = limitCheck.dailyLimit;
        withdraw.daily_withdrawn_before = limitCheck.alreadyWithdrawn;
        withdraw.customer_category = limitCheck.customerCategory;
        withdraw.needs_checker = checkerCheck.needsChecker;
        withdraw.checker_threshold = checkerCheck.threshold;

        if (checkerCheck.needsChecker) {
            // Needs checker approval - set to pending_checker
            // Save Maker (Initiator) information
            withdraw.status = 'pending_checker';
            withdraw.maker_name = posted_by || req.user?.name;
            withdraw.maker_id = req.user?.userId || req.user?.id;
            withdraw.maker_date = new Date();
            withdraw.maker_remarks = remarks || '';
            withdraw.posted_by = posted_by || req.user?.name;
            withdraw.posted_date = new Date();
            await withdraw.save();

            console.log('\n' + '='.repeat(80));
            console.log('[WITHDRAW_ROUTE] Transaction requires CHECKER APPROVAL');
            console.log('='.repeat(80));
            console.log('Withdraw ID:', withdraw_id);
            console.log('Account:', withdraw.account_number);
            console.log('Amount:', amount);
            console.log('Threshold:', checkerCheck.threshold);
            console.log('Maker (Initiator):', withdraw.maker_name);
            console.log('Maker ID:', withdraw.maker_id);
            console.log('Maker Date:', withdraw.maker_date);
            console.log('Status:', 'pending_checker');
            console.log('='.repeat(80) + '\n');

            return res.status(200).json({
                error: false,
                message: `Transaction requires checker approval (amount ${amount} >= threshold ${checkerCheck.threshold})`,
                data: {
                    withdraw,
                    needsChecker: true,
                    status: 'pending_checker',
                    maker: {
                        name: withdraw.maker_name,
                        id: withdraw.maker_id,
                        date: withdraw.maker_date
                    }
                }
            });
        }

        // No checker needed - process directly
        console.log('\n' + '='.repeat(80));
        console.log('[WITHDRAW_ROUTE] Processing withdrawal - NO CHECKER NEEDED');
        console.log('='.repeat(80));
        console.log('Withdraw ID:', withdraw_id);
        console.log('Account:', withdraw.account_number);
        console.log('Amount:', amount);
        console.log('Branch:', withdraw.branch);
        console.log('XREF:', withdraw.xref);
        console.log('Posted By:', posted_by || req.user?.name);
        console.log('Denomination:', JSON.stringify(finalDenomination, null, 2));
        console.log('='.repeat(80) + '\n');

        // ============================================
        // STEP 1: Execute SOAP Transaction to Flexcube
        // ============================================
        console.log('[WITHDRAW_ROUTE] STEP 1: Executing SOAP Transaction to Flexcube...');

        const soapResult = await FlexcubeTransactionService.createWithdrawTransaction({
            customerAccount: withdraw.account_number,
            amount: amount,
            tellerBranch: withdraw.branch || FlexcubeTransactionService.extractBranchFromAccount(withdraw.account_number),
            glAccount: '101101', // GL account for cash
            xref: withdraw.xref,
            narrative: `WITHDRAW-${withdraw.account_number}-BY-${posted_by || req.user?.name || 'TELLER'}`
        });

        console.log('\n[WITHDRAW_ROUTE] SOAP Result:', JSON.stringify({
            success: soapResult.success,
            trnRefNo: soapResult.trnRefNo,
            error: soapResult.error,
            httpStatus: soapResult.httpStatus
        }, null, 2));

        // Check if SOAP transaction succeeded
        if (!soapResult.success) {
            console.error('[WITHDRAW_ROUTE] SOAP Transaction FAILED!');
            console.error('Error:', soapResult.error);

            // Save the failed response but don't mark as posted
            withdraw.flexcube_response = {
                success: false,
                error: soapResult.error,
                rawResponse: soapResult.rawResponse?.substring(0, 1000), // Truncate for storage
                timestamp: new Date()
            };
            withdraw.status = 'assigned'; // Keep as assigned so teller can retry
            await withdraw.save();

            return res.status(400).json({
                error: true,
                message: `Flexcube transaction failed: ${soapResult.error}`,
                data: {
                    soapError: soapResult.error,
                    withdraw
                }
            });
        }

        console.log('[WITHDRAW_ROUTE] SOAP Transaction SUCCESS!');
        console.log('Flexcube TRN Ref:', soapResult.trnRefNo);

        // ============================================
        // STEP 2: Update withdraw record with success
        // ============================================
        withdraw.status = 'posted';
        withdraw.posted_by = posted_by || req.user?.name;
        withdraw.posted_date = new Date();
        withdraw.trn_ref_no = soapResult.trnRefNo || trn_ref_no || `TRN${Date.now()}`;
        withdraw.flexcube_response = {
            success: true,
            trnRefNo: soapResult.trnRefNo,
            timestamp: new Date()
        };

        // ============================================
        // STEP 3: Update Till (deduct from teller's till)
        // ============================================
        const tillId = req.user?.till_id;
        const branchCode = req.user?.branch;
        console.log('\n[WITHDRAW_ROUTE] STEP 2: Starting Till Update');
        console.log('[WITHDRAW_ROUTE] Till ID:', tillId, 'Branch Code:', branchCode);
        // User context available from JWT
        try {
            const tillResult = await FlexcubeTransactionService.updateTillForWithdraw(
                tillId,
                branchCode,
                finalDenomination
            );
            console.log('[WITHDRAW_ROUTE] Till Update Result:', JSON.stringify(tillResult, null, 2));
            withdraw.till_updated = tillResult.success;
            withdraw.till_update_date = new Date();
        } catch (tillError) {
            console.error("[WITHDRAW_ROUTE] Till update EXCEPTION:", tillError.message);
            // Continue even if till update fails - the Flexcube transaction already succeeded
            withdraw.till_updated = false;
        }

        // ============================================
        // STEP 4: Save and return success
        // ============================================
        console.log('[WITHDRAW_ROUTE] STEP 3: Saving withdraw document...');
        await withdraw.save();
        console.log('[WITHDRAW_ROUTE] Withdraw saved successfully');

        console.log('\n' + '='.repeat(80));
        console.log('[WITHDRAW_ROUTE] WITHDRAWAL COMPLETE - SUCCESS');
        console.log('Status:', withdraw.status);
        console.log('Flexcube TRN Ref:', withdraw.trn_ref_no);
        console.log('Till Updated:', withdraw.till_updated);
        console.log('='.repeat(80) + '\n');

        res.status(200).json({
            error: false,
            message: "Withdrawal processed successfully",
            data: {
                withdraw,
                needsChecker: false,
                status: 'posted',
                flexcubeTrnRef: soapResult.trnRefNo
            }
        });

    } catch (e) {
        console.error("[PROCESS_WITHDRAW] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Failed to process withdrawal"
        });
    }
});

/**
 * Process E-Check transaction with denomination (Teller posting - same as withdraw)
 */
router.post("/process-echeck-with-denomination", auth, async (req, res) => {
    try {
        const {
            echeck_id,
            denomination,
            trn_ref_no,
            posted_by,
            remarks
        } = req.body;

        if (!echeck_id) {
            return res.status(400).json({
                error: true,
                message: "E-Check ID is required"
            });
        }

        // Find the E-Check request
        const echeck = await ECheck.findById(echeck_id);
        if (!echeck) {
            return res.status(404).json({
                error: true,
                message: "E-Check request not found"
            });
        }

        // Validate status
        if (!['assigned', 'assigned_by_csr'].includes(echeck.status)) {
            return res.status(400).json({
                error: true,
                message: `Cannot process E-Check with status: ${echeck.status}`
            });
        }

        const amount = parseFloat(echeck.amount_in_figures);

        // If denomination provided, validate it
        let finalDenomination = denomination;
        if (denomination) {
            const denomTotal = FlexcubeTransactionService.calculateDenominationTotal(denomination);
            if (Math.abs(denomTotal - amount) > 0.01) {
                return res.status(400).json({
                    error: true,
                    message: `Denomination total (${denomTotal}) does not match amount (${amount})`
                });
            }
        } else {
            // Auto-populate denomination if not provided
            finalDenomination = FlexcubeTransactionService.autopopulateDenomination(amount);
        }

        // Check withdrawal limit (E-Check uses same limits as withdraw)
        const limitCheck = await FlexcubeTransactionService.checkWithdrawalLimit(
            echeck.account_number,
            amount
        );

        if (!limitCheck.allowed) {
            // Reject the transaction
            echeck.status = 'rejected';
            echeck.rejection_reason = limitCheck.reason;
            echeck.limit_check_passed = false;
            echeck.daily_limit = limitCheck.dailyLimit;
            echeck.daily_withdrawn_before = limitCheck.alreadyWithdrawn;
            echeck.customer_category = limitCheck.customerCategory;
            await echeck.save();

            return res.status(400).json({
                error: true,
                message: `E-Check rejected: ${limitCheck.reason}`,
                data: {
                    limitCheck,
                    status: 'rejected'
                }
            });
        }

        // Check maker-checker threshold
        const checkerCheck = await FlexcubeTransactionService.checkMakerCheckerThreshold(amount);

        // Generate XREF if not exists
        if (!echeck.xref) {
            echeck.xref = await ECheck.generateXref();
        }

        // Update E-Check with limit and denomination info
        echeck.denomination = finalDenomination;
        echeck.denomination_total = FlexcubeTransactionService.calculateDenominationTotal(finalDenomination);
        echeck.limit_check_passed = true;
        echeck.daily_limit = limitCheck.dailyLimit;
        echeck.daily_withdrawn_before = limitCheck.alreadyWithdrawn;
        echeck.customer_category = limitCheck.customerCategory;
        echeck.needs_checker = checkerCheck.needsChecker;
        echeck.checker_threshold = checkerCheck.threshold;

        if (checkerCheck.needsChecker) {
            // Needs checker approval - set to pending_checker
            // Save Maker (Initiator) information
            echeck.status = 'pending_checker';
            echeck.maker_name = posted_by || req.user?.name;
            echeck.maker_id = req.user?.userId || req.user?.id;
            echeck.maker_date = new Date();
            echeck.maker_remarks = remarks || '';
            echeck.posted_by = posted_by || req.user?.name;
            echeck.posted_date = new Date();
            await echeck.save();

            console.log('\n' + '='.repeat(80));
            console.log('[ECHECK_ROUTE] Transaction requires CHECKER APPROVAL');
            console.log('='.repeat(80));
            console.log('E-Check ID:', echeck_id);
            console.log('Account:', echeck.account_number);
            console.log('Amount:', amount);
            console.log('Threshold:', checkerCheck.threshold);
            console.log('Maker (Initiator):', echeck.maker_name);
            console.log('Maker ID:', echeck.maker_id);
            console.log('Maker Date:', echeck.maker_date);
            console.log('Recipient:', echeck.recipient_full_name);
            console.log('Recipient Phone:', echeck.recipient_phone_number);
            console.log('Status:', 'pending_checker');
            console.log('='.repeat(80) + '\n');

            return res.status(200).json({
                error: false,
                message: `Transaction requires checker approval (amount ${amount} >= threshold ${checkerCheck.threshold})`,
                data: {
                    echeck,
                    needsChecker: true,
                    status: 'pending_checker',
                    maker: {
                        name: echeck.maker_name,
                        id: echeck.maker_id,
                        date: echeck.maker_date
                    }
                }
            });
        }

        // No checker needed - process directly
        console.log('\n' + '='.repeat(80));
        console.log('[ECHECK_ROUTE] Processing E-Check - NO CHECKER NEEDED');
        console.log('='.repeat(80));
        console.log('E-Check ID:', echeck_id);
        console.log('Account:', echeck.account_number);
        console.log('Amount:', amount);
        console.log('Branch:', echeck.branch);
        console.log('XREF:', echeck.xref);
        console.log('Posted By:', posted_by || req.user?.name);
        console.log('Recipient:', echeck.recipient_full_name);
        console.log('Recipient Phone:', echeck.recipient_phone_number);
        console.log('Denomination:', JSON.stringify(finalDenomination, null, 2));
        console.log('='.repeat(80) + '\n');

        // ============================================
        // STEP 1: Execute SOAP Transaction to Flexcube (same as withdraw)
        // ============================================
        console.log('[ECHECK_ROUTE] STEP 1: Executing SOAP Transaction to Flexcube...');

        const soapResult = await FlexcubeTransactionService.createWithdrawTransaction({
            customerAccount: echeck.account_number,
            amount: amount,
            tellerBranch: echeck.branch || FlexcubeTransactionService.extractBranchFromAccount(echeck.account_number),
            glAccount: '101101', // GL account for cash
            xref: echeck.xref,
            narrative: `ECHECK-${echeck.account_number}-BY-${posted_by || req.user?.name || 'TELLER'}-TO-${echeck.recipient_full_name}`
        });

        console.log('\n[ECHECK_ROUTE] SOAP Result:', JSON.stringify({
            success: soapResult.success,
            trnRefNo: soapResult.trnRefNo,
            error: soapResult.error,
            httpStatus: soapResult.httpStatus
        }, null, 2));

        // Check if SOAP transaction succeeded
        if (!soapResult.success) {
            console.error('[ECHECK_ROUTE] SOAP Transaction FAILED!');
            console.error('Error:', soapResult.error);

            // Save the failed response but don't mark as posted
            echeck.flexcube_response = {
                success: false,
                error: soapResult.error,
                rawResponse: soapResult.rawResponse?.substring(0, 1000), // Truncate for storage
                timestamp: new Date()
            };
            echeck.status = 'assigned'; // Keep as assigned so teller can retry
            await echeck.save();

            return res.status(400).json({
                error: true,
                message: `Flexcube transaction failed: ${soapResult.error}`,
                data: {
                    soapError: soapResult.error,
                    echeck
                }
            });
        }

        console.log('[ECHECK_ROUTE] SOAP Transaction SUCCESS!');
        console.log('Flexcube TRN Ref:', soapResult.trnRefNo);

        // ============================================
        // STEP 2: Update E-Check record with success
        // ============================================
        echeck.status = 'posted';
        echeck.posted_by = posted_by || req.user?.name;
        echeck.posted_date = new Date();
        echeck.trn_ref_no = soapResult.trnRefNo || trn_ref_no || `TRN${Date.now()}`;
        echeck.flexcube_response = {
            success: true,
            trnRefNo: soapResult.trnRefNo,
            timestamp: new Date()
        };

        // ============================================
        // STEP 3: Update Till (deduct from teller's till - same as withdraw)
        // ============================================
        const tillId = req.user?.till_id;
        const branchCode = req.user?.branch;
        console.log('\n[ECHECK_ROUTE] STEP 2: Starting Till Update');
        console.log('[ECHECK_ROUTE] Till ID:', tillId, 'Branch Code:', branchCode);
        // User context available from JWT
        try {
            const tillResult = await FlexcubeTransactionService.updateTillForWithdraw(
                tillId,
                branchCode,
                finalDenomination
            );
            console.log('[ECHECK_ROUTE] Till Update Result:', JSON.stringify(tillResult, null, 2));
            echeck.till_updated = tillResult.success;
            echeck.till_update_date = new Date();
        } catch (tillError) {
            console.error("[ECHECK_ROUTE] Till update EXCEPTION:", tillError.message);
            // Continue even if till update fails - the Flexcube transaction already succeeded
            echeck.till_updated = false;
        }

        // ============================================
        // STEP 4: Save and return success
        // ============================================
        console.log('[ECHECK_ROUTE] STEP 3: Saving E-Check document...');
        await echeck.save();
        console.log('[ECHECK_ROUTE] E-Check saved successfully');

        console.log('\n' + '='.repeat(80));
        console.log('[ECHECK_ROUTE] E-CHECK COMPLETE - SUCCESS');
        console.log('Status:', echeck.status);
        console.log('Flexcube TRN Ref:', echeck.trn_ref_no);
        console.log('Till Updated:', echeck.till_updated);
        console.log('Recipient:', echeck.recipient_full_name);
        console.log('Recipient Phone:', echeck.recipient_phone_number);
        console.log('='.repeat(80) + '\n');

        res.status(200).json({
            error: false,
            message: "E-Check processed successfully",
            data: {
                echeck,
                needsChecker: false,
                status: 'posted',
                flexcubeTrnRef: soapResult.trnRefNo
            }
        });

    } catch (e) {
        console.error("[PROCESS_ECHECK] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Failed to process E-Check"
        });
    }
});

/**
 * Process deposit transaction with denomination (Teller posting)
 */
router.post("/process-deposit-with-denomination", auth, async (req, res) => {
    try {
        const {
            deposit_id,
            denomination,
            trn_ref_no,
            posted_by,
            remarks
        } = req.body;

        if (!deposit_id) {
            return res.status(400).json({
                error: true,
                message: "Deposit ID is required"
            });
        }

        // Find the deposit request
        const deposit = await Deposit.findById(deposit_id);
        if (!deposit) {
            return res.status(404).json({
                error: true,
                message: "Deposit request not found"
            });
        }

        // Validate status
        if (!['assigned', 'assigned_by_csr'].includes(deposit.status)) {
            return res.status(400).json({
                error: true,
                message: `Cannot process deposit with status: ${deposit.status}`
            });
        }

        const amount = parseFloat(deposit.amount_in_figures);

        // If denomination provided, validate it
        let finalDenomination = denomination;
        if (denomination) {
            const denomTotal = FlexcubeTransactionService.calculateDenominationTotal(denomination);
            if (Math.abs(denomTotal - amount) > 0.01) {
                return res.status(400).json({
                    error: true,
                    message: `Denomination total (${denomTotal}) does not match amount (${amount})`
                });
            }
        } else {
            // For deposit, denomination is typically provided by customer
            // But we can auto-populate if needed
            finalDenomination = FlexcubeTransactionService.autopopulateDenomination(amount);
        }

        // Generate XREF if not exists
        if (!deposit.xref) {
            deposit.xref = await Deposit.generateXref();
        }

        // Update deposit with denomination info
        deposit.denomination = finalDenomination;
        deposit.denomination_total = FlexcubeTransactionService.calculateDenominationTotal(finalDenomination);

        // Process directly - No limit check, No maker-checker for deposits
        console.log('\n' + '='.repeat(80));
        console.log('[DEPOSIT_ROUTE] Processing deposit');
        console.log('='.repeat(80));
        console.log('Deposit ID:', deposit_id);
        console.log('Account:', deposit.account_number);
        console.log('Amount:', amount);
        console.log('Branch:', deposit.branch);
        console.log('XREF:', deposit.xref);
        console.log('Posted By:', posted_by || req.user?.name);
        console.log('Denomination:', JSON.stringify(finalDenomination, null, 2));
        console.log('='.repeat(80) + '\n');

        // ============================================
        // STEP 1: Execute SOAP Transaction to Flexcube
        // ============================================
        console.log('[DEPOSIT_ROUTE] STEP 1: Executing SOAP Transaction to Flexcube...');

        const soapResult = await FlexcubeTransactionService.createDepositTransaction({
            customerAccount: deposit.account_number,
            amount: amount,
            tellerBranch: deposit.branch || FlexcubeTransactionService.extractBranchFromAccount(deposit.account_number),
            glAccount: '101101', // GL account for cash
            xref: deposit.xref,
            narrative: `DEPOSIT-${deposit.account_number}-BY-${posted_by || req.user?.name || 'TELLER'}`
        });

        console.log('\n[DEPOSIT_ROUTE] SOAP Result:', JSON.stringify({
            success: soapResult.success,
            trnRefNo: soapResult.trnRefNo,
            error: soapResult.error,
            httpStatus: soapResult.httpStatus
        }, null, 2));

        // Check if SOAP transaction succeeded
        if (!soapResult.success) {
            console.error('[DEPOSIT_ROUTE] SOAP Transaction FAILED!');
            console.error('Error:', soapResult.error);

            // Save the failed response but don't mark as posted
            deposit.flexcube_response = {
                success: false,
                error: soapResult.error,
                rawResponse: soapResult.rawResponse?.substring(0, 1000), // Truncate for storage
                timestamp: new Date()
            };
            deposit.status = 'assigned'; // Keep as assigned so teller can retry
            await deposit.save();

            return res.status(400).json({
                error: true,
                message: `Flexcube transaction failed: ${soapResult.error}`,
                data: {
                    soapError: soapResult.error,
                    deposit
                }
            });
        }

        console.log('[DEPOSIT_ROUTE] SOAP Transaction SUCCESS!');
        console.log('Flexcube TRN Ref:', soapResult.trnRefNo);

        // ============================================
        // STEP 2: Update deposit record with success
        // ============================================
        deposit.status = 'posted';
        deposit.posted_by = posted_by || req.user?.name;
        deposit.posted_date = new Date();
        deposit.trn_ref_no = soapResult.trnRefNo || trn_ref_no || `TRN${Date.now()}`;
        deposit.flexcube_response = {
            success: true,
            trnRefNo: soapResult.trnRefNo,
            timestamp: new Date()
        };

        // ============================================
        // STEP 3: Update Till (add to teller's till)
        // ============================================
        const tillId = req.user?.till_id;
        const branchCode = req.user?.branch;
        console.log('\n[DEPOSIT_ROUTE] STEP 2: Starting Till Update');
        console.log('[DEPOSIT_ROUTE] Till ID:', tillId, 'Branch Code:', branchCode);
        // User context available from JWT
        try {
            const tillResult = await FlexcubeTransactionService.updateTillForDeposit(
                tillId,
                branchCode,
                finalDenomination
            );
            console.log('[DEPOSIT_ROUTE] Till Update Result:', JSON.stringify(tillResult, null, 2));
            deposit.till_updated = tillResult.success;
            deposit.till_update_date = new Date();
        } catch (tillError) {
            console.error("[DEPOSIT_ROUTE] Till update EXCEPTION:", tillError.message);
            // Continue even if till update fails - the Flexcube transaction already succeeded
            deposit.till_updated = false;
        }

        // ============================================
        // STEP 4: Save and return success
        // ============================================
        console.log('[DEPOSIT_ROUTE] STEP 3: Saving deposit document...');
        await deposit.save();
        console.log('[DEPOSIT_ROUTE] Deposit saved successfully');

        console.log('\n' + '='.repeat(80));
        console.log('[DEPOSIT_ROUTE] DEPOSIT COMPLETE - SUCCESS');
        console.log('Status:', deposit.status);
        console.log('Flexcube TRN Ref:', deposit.trn_ref_no);
        console.log('Till Updated:', deposit.till_updated);
        console.log('='.repeat(80) + '\n');

        res.status(200).json({
            error: false,
            message: "Deposit processed successfully",
            data: {
                deposit,
                needsChecker: false,
                status: 'posted',
                flexcubeTrnRef: soapResult.trnRefNo
            }
        });

    } catch (e) {
        console.error("[PROCESS_DEPOSIT] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Failed to process deposit"
        });
    }
});

/**
 * Process transfer transaction (Teller posting)
 * Transfer: Debit source account, Credit beneficiary account
 * No till update needed (no cash involved)
 * No limit check needed (account to account transfer)
 * No denomination needed (no cash involved)
 * Only SOAP transaction to Flexcube
 */
router.post("/process-transfer", auth, async (req, res) => {
    try {
        const {
            transfer_id,
            trn_ref_no,
            posted_by,
            remarks
        } = req.body;

        if (!transfer_id) {
            return res.status(400).json({
                error: true,
                message: "Transfer ID is required"
            });
        }

        // Find the transfer request
        const transfer = await Transfer.findById(transfer_id);
        if (!transfer) {
            return res.status(404).json({
                error: true,
                message: "Transfer request not found"
            });
        }

        // Validate status
        if (!['assigned', 'assigned_by_csr'].includes(transfer.status)) {
            return res.status(400).json({
                error: true,
                message: `Cannot process transfer with status: ${transfer.status}`
            });
        }

        const amount = parseFloat(transfer.amount_in_figures);

        // Generate XREF if not exists
        if (!transfer.xref) {
            transfer.xref = await Transfer.generateXref();
        }

        // Process directly via SOAP - No limit check, No maker-checker for transfers
        console.log('\n' + '='.repeat(80));
        console.log('[TRANSFER_ROUTE] Processing transfer');
        console.log('='.repeat(80));
        console.log('Transfer ID:', transfer_id);
        console.log('From Account:', transfer.account_number);
        console.log('To Account:', transfer.beneficiary_account_number);
        console.log('Beneficiary Name:', transfer.beneficiary_name);
        console.log('Amount:', amount);
        console.log('Branch:', transfer.branch);
        console.log('XREF:', transfer.xref);
        console.log('Posted By:', posted_by || req.user?.name);
        console.log('Narration:', transfer.payment_narration);
        console.log('='.repeat(80) + '\n');

        // ============================================
        // STEP 1: Execute SOAP Transaction to Flexcube
        // ============================================
        console.log('[TRANSFER_ROUTE] STEP 1: Executing SOAP Transaction to Flexcube...');

        const soapResult = await FlexcubeTransactionService.createTransferTransaction({
            fromAccount: transfer.account_number,
            toAccount: transfer.beneficiary_account_number,
            amount: amount,
            tellerBranch: transfer.branch || FlexcubeTransactionService.extractBranchFromAccount(transfer.account_number),
            xref: transfer.xref,
            narrative: transfer.payment_narration || `TRANSFER-${transfer.account_number}-TO-${transfer.beneficiary_account_number}`
        });

        console.log('\n[TRANSFER_ROUTE] SOAP Result:', JSON.stringify({
            success: soapResult.success,
            trnRefNo: soapResult.trnRefNo,
            error: soapResult.error,
            httpStatus: soapResult.httpStatus
        }, null, 2));

        // Check if SOAP transaction succeeded
        if (!soapResult.success) {
            console.error('[TRANSFER_ROUTE] SOAP Transaction FAILED!');
            console.error('Error:', soapResult.error);

            // Save the failed response but don't mark as posted
            transfer.flexcube_response = {
                success: false,
                error: soapResult.error,
                rawResponse: soapResult.rawResponse?.substring(0, 1000), // Truncate for storage
                timestamp: new Date()
            };
            transfer.status = 'assigned'; // Keep as assigned so teller can retry
            await transfer.save();

            return res.status(400).json({
                error: true,
                message: `Flexcube transaction failed: ${soapResult.error}`,
                data: {
                    soapError: soapResult.error,
                    transfer
                }
            });
        }

        console.log('[TRANSFER_ROUTE] SOAP Transaction SUCCESS!');
        console.log('Flexcube TRN Ref:', soapResult.trnRefNo);

        // ============================================
        // STEP 2: Update transfer record with success
        // ============================================
        transfer.status = 'posted';
        transfer.posted_by = posted_by || req.user?.name;
        transfer.posted_date = new Date();
        transfer.trn_ref_no = soapResult.trnRefNo || trn_ref_no || `TRN${Date.now()}`;
        transfer.flexcube_response = {
            success: true,
            trnRefNo: soapResult.trnRefNo,
            timestamp: new Date()
        };

        // Note: No till update for transfers (no cash involved)

        // ============================================
        // STEP 3: Save and return success
        // ============================================
        console.log('[TRANSFER_ROUTE] STEP 2: Saving transfer document...');
        await transfer.save();
        console.log('[TRANSFER_ROUTE] Transfer saved successfully');

        console.log('\n' + '='.repeat(80));
        console.log('[TRANSFER_ROUTE] TRANSFER COMPLETE - SUCCESS');
        console.log('Status:', transfer.status);
        console.log('Flexcube TRN Ref:', transfer.trn_ref_no);
        console.log('From:', transfer.account_number);
        console.log('To:', transfer.beneficiary_account_number);
        console.log('Amount:', amount);
        console.log('='.repeat(80) + '\n');

        res.status(200).json({
            error: false,
            message: "Transfer processed successfully",
            data: {
                transfer,
                needsChecker: false,
                status: 'posted',
                flexcubeTrnRef: soapResult.trnRefNo
            }
        });

    } catch (e) {
        console.error("[PROCESS_TRANSFER] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Failed to process transfer"
        });
    }
});

/**
 * Get transactions pending checker approval
 * For Authorizer/Checker role
 */
router.get("/pending-checker-transactions", auth, async (req, res) => {
    try {
        const { branch } = req.query;

        const query = { status: 'pending_checker' };
        if (branch) {
            query.branch = branch;
        }

        // Get pending deposits, withdrawals, and echecks
        const [pendingDeposits, pendingWithdraws, pendingEChecks] = await Promise.all([
            Deposit.find(query).sort({ posted_date: -1 }),
            Withdraw.find(query).sort({ posted_date: -1 }),
            ECheck.find(query).sort({ posted_date: -1 })
        ]);

        // Combine and add type field
        const pendingTransactions = [
            ...pendingDeposits.map(d => ({ ...d.toObject(), transaction_type: 'Deposit' })),
            ...pendingWithdraws.map(w => ({ ...w.toObject(), transaction_type: 'Withdraw' })),
            ...pendingEChecks.map(e => ({ ...e.toObject(), transaction_type: 'ECheck' }))
        ].sort((a, b) => new Date(b.posted_date) - new Date(a.posted_date));

        res.status(200).json({
            error: false,
            message: `Found ${pendingTransactions.length} transactions pending checker approval`,
            data: pendingTransactions
        });

    } catch (e) {
        console.error("[GET_PENDING_CHECKER] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Failed to fetch pending transactions"
        });
    }
});

/**
 * Approve or reject pending transaction (Checker action)
 */
router.post("/approve-pending-transaction", auth, async (req, res) => {
    try {
        const {
            transaction_id,
            transaction_type, // 'Deposit' or 'Withdraw'
            action, // 'approve' or 'reject'
            checker_name,
            checker_remarks,
            trn_ref_no
        } = req.body;

        if (!transaction_id || !transaction_type || !action) {
            return res.status(400).json({
                error: true,
                message: "Transaction ID, type, and action are required"
            });
        }

        if (!['approve', 'reject'].includes(action)) {
            return res.status(400).json({
                error: true,
                message: "Action must be 'approve' or 'reject'"
            });
        }

        let transaction;
        if (transaction_type === 'Deposit') {
            transaction = await Deposit.findById(transaction_id);
        } else if (transaction_type === 'Withdraw') {
            transaction = await Withdraw.findById(transaction_id);
        } else if (transaction_type === 'ECheck' || transaction_type === 'E-Check') {
            transaction = await ECheck.findById(transaction_id);
        } else {
            return res.status(400).json({
                error: true,
                message: "Invalid transaction type"
            });
        }

        if (!transaction) {
            return res.status(404).json({
                error: true,
                message: "Transaction not found"
            });
        }

        if (transaction.status !== 'pending_checker') {
            return res.status(400).json({
                error: true,
                message: `Transaction is not pending checker approval (current status: ${transaction.status})`
            });
        }

        // Update checker (authorizer) fields
        transaction.checker_name = checker_name || req.user?.name;
        transaction.checker_id = req.user?.userId || req.user?.id;
        transaction.checker_date = new Date();
        transaction.checker_remarks = checker_remarks;
        transaction.checker_action = action === 'approve' ? 'approved' : 'rejected';

        const amount = parseFloat(transaction.amount_in_figures);

        if (action === 'reject') {
            transaction.status = 'rejected';
            transaction.rejection_reason = checker_remarks || 'Rejected by checker';
            await transaction.save();

            console.log('\n' + '='.repeat(80));
            console.log('[CHECKER_APPROVAL] Transaction REJECTED');
            console.log('='.repeat(80));
            console.log('Transaction ID:', transaction_id);
            console.log('Transaction Type:', transaction_type);
            console.log('Amount:', amount);
            console.log('Maker (Initiator):', transaction.maker_name || transaction.posted_by);
            console.log('Maker Date:', transaction.maker_date || transaction.posted_date);
            console.log('Checker (Authorizer):', transaction.checker_name);
            console.log('Checker ID:', transaction.checker_id);
            console.log('Checker Date:', transaction.checker_date);
            console.log('Rejection Reason:', transaction.rejection_reason);
            console.log('='.repeat(80) + '\n');

            return res.status(200).json({
                error: false,
                message: "Transaction rejected by checker",
                data: {
                    transaction,
                    action: 'rejected',
                    maker: {
                        name: transaction.maker_name || transaction.posted_by,
                        date: transaction.maker_date || transaction.posted_date
                    },
                    checker: {
                        name: transaction.checker_name,
                        id: transaction.checker_id,
                        date: transaction.checker_date,
                        action: 'rejected'
                    }
                }
            });
        }

        // Approve - process the transaction via SOAP
        console.log('\n' + '='.repeat(80));
        console.log('[CHECKER_APPROVAL] Processing APPROVED transaction');
        console.log('='.repeat(80));
        console.log('Transaction ID:', transaction_id);
        console.log('Transaction Type:', transaction_type);
        console.log('Account:', transaction.account_number);
        console.log('Amount:', amount);
        console.log('XREF:', transaction.xref);
        console.log('Maker (Initiator):', transaction.maker_name || transaction.posted_by);
        console.log('Maker Date:', transaction.maker_date || transaction.posted_date);
        console.log('Checker (Authorizer):', transaction.checker_name);
        console.log('Checker ID:', transaction.checker_id);
        console.log('Checker Date:', transaction.checker_date);
        console.log('='.repeat(80) + '\n');

        // ============================================
        // STEP 1: Execute SOAP Transaction to Flexcube
        // ============================================
        console.log('[CHECKER_APPROVAL] STEP 1: Executing SOAP Transaction to Flexcube...');

        let soapResult;
        if (transaction_type === 'Withdraw') {
            soapResult = await FlexcubeTransactionService.createWithdrawTransaction({
                customerAccount: transaction.account_number,
                amount: amount,
                tellerBranch: transaction.branch || FlexcubeTransactionService.extractBranchFromAccount(transaction.account_number),
                glAccount: '101101',
                xref: transaction.xref,
                narrative: `WITHDRAW-${transaction.account_number}-MAKER-${transaction.maker_name || transaction.posted_by}-CHECKER-${transaction.checker_name}`
            });
        } else {
            // Deposit - should not normally reach here as deposits don't need checker
            soapResult = await FlexcubeTransactionService.createDepositTransaction({
                customerAccount: transaction.account_number,
                amount: amount,
                tellerBranch: transaction.branch || FlexcubeTransactionService.extractBranchFromAccount(transaction.account_number),
                glAccount: '101101',
                xref: transaction.xref,
                narrative: `DEPOSIT-${transaction.account_number}-MAKER-${transaction.maker_name || transaction.posted_by}-CHECKER-${transaction.checker_name}`
            });
        }

        console.log('\n[CHECKER_APPROVAL] SOAP Result:', JSON.stringify({
            success: soapResult.success,
            trnRefNo: soapResult.trnRefNo,
            error: soapResult.error,
            httpStatus: soapResult.httpStatus
        }, null, 2));

        // Check if SOAP transaction succeeded
        if (!soapResult.success) {
            console.error('[CHECKER_APPROVAL] SOAP Transaction FAILED!');
            console.error('Error:', soapResult.error);

            // Save the failed response but keep as pending_checker for retry
            transaction.flexcube_response = {
                success: false,
                error: soapResult.error,
                rawResponse: soapResult.rawResponse?.substring(0, 1000),
                timestamp: new Date()
            };
            // Reset checker action since SOAP failed
            transaction.checker_action = null;
            await transaction.save();

            return res.status(400).json({
                error: true,
                message: `Flexcube transaction failed: ${soapResult.error}`,
                data: {
                    soapError: soapResult.error,
                    transaction
                }
            });
        }

        console.log('[CHECKER_APPROVAL] SOAP Transaction SUCCESS!');
        console.log('Flexcube TRN Ref:', soapResult.trnRefNo);

        // ============================================
        // STEP 2: Update transaction record
        // ============================================
        transaction.status = 'posted';
        transaction.trn_ref_no = soapResult.trnRefNo || trn_ref_no || `TRN${Date.now()}`;
        transaction.flexcube_response = {
            success: true,
            trnRefNo: soapResult.trnRefNo,
            timestamp: new Date()
        };

        // ============================================
        // STEP 3: Update Till based on transaction type
        // Note: Using checker's till_id since they're processing the transaction
        // If this should use maker's till, we need to lookup maker's user record
        // ============================================
        const tillId = req.user?.till_id;
        const branchCode = req.user?.branch;
        console.log('\n[CHECKER_APPROVAL] STEP 2: Starting Till Update...');
        console.log('[CHECKER_APPROVAL] Till ID:', tillId, 'Branch Code:', branchCode);
        try {
            if (transaction_type === 'Deposit') {
                const tillResult = await FlexcubeTransactionService.updateTillForDeposit(
                    tillId,
                    branchCode,
                    transaction.denomination
                );
                console.log('[CHECKER_APPROVAL] Till Update (Deposit) Result:', JSON.stringify(tillResult, null, 2));
            } else {
                const tillResult = await FlexcubeTransactionService.updateTillForWithdraw(
                    tillId,
                    branchCode,
                    transaction.denomination
                );
                console.log('[CHECKER_APPROVAL] Till Update (Withdraw) Result:', JSON.stringify(tillResult, null, 2));
            }
            transaction.till_updated = true;
            transaction.till_update_date = new Date();
        } catch (tillError) {
            console.error("[CHECKER_APPROVAL] Till update EXCEPTION:", tillError.message);
            transaction.till_updated = false;
        }

        // ============================================
        // STEP 4: Save and return success
        // ============================================
        console.log('[CHECKER_APPROVAL] STEP 3: Saving transaction...');
        await transaction.save();

        console.log('\n' + '='.repeat(80));
        console.log('[CHECKER_APPROVAL] TRANSACTION COMPLETE - APPROVED');
        console.log('='.repeat(80));
        console.log('Status:', transaction.status);
        console.log('Flexcube TRN Ref:', transaction.trn_ref_no);
        console.log('Till Updated:', transaction.till_updated);
        console.log('Maker:', transaction.maker_name || transaction.posted_by);
        console.log('Checker:', transaction.checker_name);
        console.log('='.repeat(80) + '\n');

        res.status(200).json({
            error: false,
            message: "Transaction approved and posted to Flexcube",
            data: {
                transaction,
                action: 'approved',
                flexcubeTrnRef: soapResult.trnRefNo,
                maker: {
                    name: transaction.maker_name || transaction.posted_by,
                    date: transaction.maker_date || transaction.posted_date
                },
                checker: {
                    name: transaction.checker_name,
                    id: transaction.checker_id,
                    date: transaction.checker_date,
                    action: 'approved'
                }
            }
        });

    } catch (e) {
        console.error("[APPROVE_PENDING_TRANSACTION] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Failed to process approval"
        });
    }
});

/**
 * Get transaction details with denomination info
 */
router.get("/transaction-details/:type/:id", auth, async (req, res) => {
    try {
        const { type, id } = req.params;

        let transaction;
        if (type === 'deposit') {
            transaction = await Deposit.findById(id);
        } else if (type === 'withdraw') {
            transaction = await Withdraw.findById(id);
        } else {
            return res.status(400).json({
                error: true,
                message: "Invalid transaction type. Use 'deposit' or 'withdraw'"
            });
        }

        if (!transaction) {
            return res.status(404).json({
                error: true,
                message: "Transaction not found"
            });
        }

        res.status(200).json({
            error: false,
            message: "Transaction details retrieved",
            data: transaction
        });

    } catch (e) {
        console.error("[GET_TRANSACTION_DETAILS] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Failed to fetch transaction details"
        });
    }
});


// ============================================
// GET TELLER'S TILL DENOMINATIONS
// Returns available denomination counts from teller's till
// ============================================
router.get("/get_till_denominations", auth, roleCheck(["Teller", "Maker", "Admin"]), async (req, res, next) => {
    try {
        const tillId = req.user?.till_id;
        const branchCode = req.user?.branch;

        if (!tillId || !branchCode) {
            return res.status(400).json({
                error: true,
                message: "User does not have till_id or branch configured. Please contact admin to set up your till."
            });
        }

        const result = await FlexcubeTransactionService.getTillDenominations(tillId, branchCode);

        if (!result.success) {
            return res.status(500).json({
                error: true,
                message: result.error || "Failed to fetch till denominations"
            });
        }

        res.status(200).json({
            error: false,
            message: "Till denominations fetched successfully",
            data: result
        });
    } catch (e) {
        console.error("[GET_TILL_DENOMS] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Failed to fetch till denominations"
        });
    }
});


// ============================================
// AUTO-POPULATE DENOMINATION WITH TILL CHECK
// Returns suggested denomination breakdown based on available till counts
// ============================================
router.post("/autopopulate_denomination", auth, roleCheck(["Teller", "Maker", "Admin"]), async (req, res, next) => {
    try {
        const { amount } = req.body;

        if (!amount || isNaN(amount) || amount <= 0) {
            return res.status(400).json({
                error: true,
                message: "Valid positive amount is required"
            });
        }

        const tillId = req.user?.till_id;
        const branchCode = req.user?.branch;

        if (!tillId || !branchCode) {
            // Fall back to basic autopopulate without till check
            const denomination = FlexcubeTransactionService.autopopulateDenomination(parseFloat(amount));
            return res.status(200).json({
                error: false,
                message: "Denomination auto-populated (till not configured)",
                data: {
                    denomination,
                    tillAvailable: null,
                    canFulfill: true,
                    warning: "User does not have till configured - cannot verify availability"
                }
            });
        }

        const result = await FlexcubeTransactionService.autopopulateDenominationWithTillCheck(
            parseFloat(amount),
            tillId,
            branchCode
        );

        res.status(200).json({
            error: false,
            message: result.canFulfill
                ? "Denomination auto-populated successfully"
                : "Denomination auto-populated with warnings - insufficient till balance",
            data: result
        });
    } catch (e) {
        console.error("[AUTOPOPULATE_DENOM] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Failed to auto-populate denomination"
        });
    }
});

/**
 * Encrypt account numbers into opaque tokens (server-to-server use only)
 * POST /api/zsmart_branch_requests/encrypt-tokens
 */
router.post("/encrypt-tokens", async (req, res) => {
    try {
        const { accountNumbers } = req.body;

        if (!accountNumbers || !Array.isArray(accountNumbers) || accountNumbers.length === 0) {
            return res.status(400).json({
                error: true,
                message: "accountNumbers array is required"
            });
        }

        // Limit batch size
        if (accountNumbers.length > 10) {
            return res.status(400).json({
                error: true,
                message: "Maximum 10 account numbers per request"
            });
        }

        const tokens = accountNumbers.map(accNo => {
            if (!/^\d{16}$/.test(accNo)) {
                throw new Error(`Invalid account number format: ${accNo}`);
            }
            return encryptAccountNumber(accNo);
        });

        res.json({
            error: false,
            tokens
        });

    } catch (e) {
        console.error("[ENCRYPT_TOKENS] Error:", e.message);
        res.status(400).json({
            error: true,
            message: e.message || "Encryption failed"
        });
    }
});

/**
 * Decrypt an encrypted token back to account number (server-to-server use only)
 * POST /api/zsmart_branch_requests/decrypt-token
 */
router.post("/decrypt-token", async (req, res) => {
    try {
        const { encryptedToken } = req.body;

        if (!encryptedToken) {
            return res.status(400).json({
                error: true,
                message: "encryptedToken is required"
            });
        }

        const accountNumber = decryptAccountToken(encryptedToken);

        res.json({
            error: false,
            accountNumber
        });

    } catch (e) {
        console.error("[DECRYPT_TOKEN] Error:", e.message);
        res.status(400).json({
            error: true,
            message: "Invalid or expired token"
        });
    }
});

/**
 * Generate OTP for customer login
 * POST /api/zsmart_branch_requests/generate-otp
 */
router.post("/generate-otp", otpLimiter, async (req, res) => {
    try {
        let { account_number, encryptedToken } = req.body;

        // If encrypted token provided, decrypt it to get account number
        if (encryptedToken && !account_number) {
            try {
                account_number = decryptAccountToken(encryptedToken);
            } catch (err) {
                return res.status(400).json({
                    error: true,
                    message: "Invalid or expired account token. Please search again."
                });
            }
        }

        if (!account_number) {
            return res.status(400).json({
                error: true,
                message: "Account number or encrypted token is required"
            });
        }

        // Validate account number format strictly
        if (!/^\d{16}$/.test(account_number)) {
            return res.status(400).json({
                error: true,
                message: "Invalid account number format"
            });
        }

        // Extract CIF from account number (16-digit account)
        const cif = extractCIF(account_number);

        // Check for account lockout - too many failed OTPs in 15 minutes
        const recentFailedOTPs = await OTP.countDocuments({
            cif,
            verified: false,
            created_at: { $gte: new Date(Date.now() - 15 * 60 * 1000) }
        });

        if (recentFailedOTPs >= 5) {
            return res.status(429).json({
                error: true,
                message: "Account temporarily locked due to too many OTP requests. Please try again later."
            });
        }

        // Get customer phone number from Flexcube
        const phoneQuery = `
            SELECT MOBILE_NUMBER as TELEPHONE
            FROM FCUBSPRD.sttm_cust_personal
            WHERE CUSTOMER_NO = :1
        `;

        const phoneResult = await executeQuery(phoneQuery, [cif]);

        if (!phoneResult.success || !phoneResult.data || phoneResult.data.length === 0 || !phoneResult.data[0].TELEPHONE) {
            return res.status(404).json({
                error: true,
                message: "Phone number not found for this account"
            });
        }

        let phoneNumber = phoneResult.data[0].TELEPHONE;

        // Format phone number if needed (remove +, ensure 251 prefix)
        phoneNumber = phoneNumber.replace('+', '').replace(/^0/, '251');

        // Generate 6-digit OTP using cryptographically secure random
        const otpCode = crypto.randomInt(100000, 999999).toString();

        // Delete any existing OTPs for this CIF
        await OTP.deleteMany({ cif });

        // Save new OTP with IP binding
        const newOTP = new OTP({
            cif,
            account_number,
            phone_number: phoneNumber,
            otp_code: otpCode,
            ip_address: req.ip
        });

        await newOTP.save();

        // Send OTP via SMS
        const smsUsername = process.env.SMS_USERNAME || 'smartbranch';
        const smsPassword = process.env.SMS_PASSWORD || 'Y8z6pTB80l6%234siD';
        const smsContent = `Your Smart Branch login OTP is: ${otpCode}. This code will expire in 3 minutes. Do not share this code with anyone.`;
        const encodedContent = encodeURIComponent(smsContent);
        const smsUrl = `https://smsgateway.zemenbank.com/http-api/send?username=${smsUsername}&password=${smsPassword}&to=${phoneNumber}&from=8011&coding=8&content=${encodedContent}`;

        try {
            const response = await fetch(smsUrl);
            if (!response.ok) {
                console.error("[GENERATE_OTP] SMS sending failed");
            }
        } catch (smsError) {
            console.error("[GENERATE_OTP] SMS sending error");
        }

        // Mask phone number for response (show only last 4 digits)
        const maskedPhone = phoneNumber.replace(/(\d{3})(\d+)(\d{4})/, '$1****$3');

        res.json({
            error: false,
            message: "OTP sent successfully",
            data: {
                maskedPhone,
                expiresIn: 180 // seconds
            }
        });

    } catch (e) {
        console.error("[GENERATE_OTP] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Failed to generate OTP"
        });
    }
});

/**
 * Verify OTP for customer login
 * POST /api/zsmart_branch_requests/verify-otp
 */
router.post("/verify-otp", otpVerifyLimiter, async (req, res) => {
    try {
        let { account_number, otp_code, encryptedToken } = req.body;

        // If encrypted token provided, decrypt it to get account number
        if (encryptedToken && !account_number) {
            try {
                account_number = decryptAccountToken(encryptedToken);
            } catch (err) {
                return res.status(400).json({
                    error: true,
                    message: "Invalid or expired account token. Please search again."
                });
            }
        }

        if (!account_number || !otp_code) {
            return res.status(400).json({
                error: true,
                message: "Account number (or encrypted token) and OTP code are required"
            });
        }

        // Validate account number format strictly
        if (!/^\d{16}$/.test(account_number)) {
            return res.status(400).json({
                error: true,
                message: "Invalid account number format"
            });
        }

        // Validate OTP format (must be 6 digits)
        if (!/^\d{6}$/.test(otp_code.trim())) {
            return res.status(400).json({
                error: true,
                message: "Invalid OTP format"
            });
        }

        // Extract CIF from account number
        const cif = extractCIF(account_number);

        // Find the OTP record
        const otpRecord = await OTP.findOne({
            cif,
            account_number,
            verified: false
        }).sort({ created_at: -1 });

        if (!otpRecord) {
            return res.status(404).json({
                error: true,
                message: "OTP not found or expired. Please request a new OTP."
            });
        }

        // Check if max attempts exceeded
        if (otpRecord.attempts >= otpRecord.max_attempts) {
            await OTP.deleteOne({ _id: otpRecord._id });
            return res.status(400).json({
                error: true,
                message: "Maximum OTP attempts exceeded. Please request a new OTP."
            });
        }

        // Verify OTP using timing-safe comparison
        const otpBuffer = Buffer.from(otpRecord.otp_code.padEnd(6));
        const inputBuffer = Buffer.from(otp_code.trim().padEnd(6));
        const isValid = crypto.timingSafeEqual(otpBuffer, inputBuffer);

        if (!isValid) {
            // Increment attempts
            otpRecord.attempts += 1;
            await otpRecord.save();

            const remainingAttempts = otpRecord.max_attempts - otpRecord.attempts;

            return res.status(400).json({
                error: true,
                message: `Invalid OTP. ${remainingAttempts} attempt(s) remaining.`
            });
        }

        // OTP is correct - mark as verified and delete
        otpRecord.verified = true;
        await otpRecord.save();
        await OTP.deleteOne({ _id: otpRecord._id });

        // Create server-side verified session (prevents client-side OTP bypass)
        // Session is CIF-based: one CIF can have multiple accounts
        const sessionToken = crypto.randomBytes(32).toString('hex');
        await VerifiedSession.create({
            session_token: sessionToken,
            cif,
            verified_account_number: account_number,
            ip_address: req.ip || req.connection?.remoteAddress
        });

        // Return both encrypted token and session token
        // sessionToken is the proof of OTP verification — cannot be forged client-side
        res.json({
            error: false,
            message: "OTP verified successfully",
            data: {
                encryptedToken: encryptAccountNumber(account_number),
                sessionToken
            }
        });

    } catch (e) {
        console.error("[VERIFY_OTP] Error:", e.message);
        res.status(500).json({
            error: true,
            message: "Failed to verify OTP"
        });
    }
});


// ============================================
// VALIDATE VERIFIED SESSION
// Returns CIF and account info from the server-side session.
// Session is CIF-based: one CIF can have multiple accounts.
// This prevents OTP bypass — the CIF is determined by the server.
// ============================================
router.post("/validate-session", async (req, res) => {
    try {
        const { sessionToken, accountNumber } = req.body;

        if (!sessionToken || typeof sessionToken !== 'string') {
            return res.status(400).json({
                error: true,
                message: "Session token is required"
            });
        }

        // Find the verified session
        const session = await VerifiedSession.findOne({
            session_token: sessionToken
        });

        if (!session) {
            return res.status(401).json({
                error: true,
                message: "Invalid or expired session. Please verify OTP again."
            });
        }

        // If accountNumber provided, verify it belongs to the same CIF
        // (allows selecting different accounts under same customer)
        const targetAccountNumber = accountNumber || session.verified_account_number;

        // Verify the target account belongs to the session's CIF
        if (accountNumber) {
            const targetCif = extractCIF(accountNumber);
            if (targetCif !== session.cif) {
                return res.status(403).json({
                    error: true,
                    message: "Account does not belong to the verified customer."
                });
            }
        }

        res.json({
            error: false,
            message: "Session validated successfully",
            data: {
                cif: session.cif,
                encryptedToken: encryptAccountNumber(targetAccountNumber)
            }
        });

    } catch (error) {
        console.error("[VALIDATE_SESSION] Error:", error.message);
        res.status(500).json({
            error: true,
            message: "Session validation failed"
        });
    }
});

// ============================================
// VERIFY SESSION FOR TRANSACTIONS
// CIF-based check — validates session and optionally checks
// that the account belongs to the session's CIF.
// Used before processing transactions.
// ============================================
router.post("/verify-transaction-session", async (req, res) => {
    try {
        const { sessionToken, encryptedToken } = req.body;

        if (!sessionToken) {
            return res.status(400).json({
                error: true,
                message: "Session token is required"
            });
        }

        const session = await VerifiedSession.findOne({
            session_token: sessionToken
        });

        if (!session) {
            return res.status(401).json({
                error: true,
                message: "Session expired. Please re-verify your identity."
            });
        }

        // If encryptedToken provided, verify the account belongs to session's CIF
        if (encryptedToken) {
            try {
                const tokenAccountNumber = decryptAccountToken(encryptedToken);
                const tokenCif = extractCIF(tokenAccountNumber);
                if (tokenCif !== session.cif) {
                    return res.status(403).json({
                        error: true,
                        message: "Account does not belong to the verified customer. Unauthorized."
                    });
                }
            } catch (decryptErr) {
                return res.status(400).json({
                    error: true,
                    message: "Invalid account token"
                });
            }
        }

        res.json({
            error: false,
            message: "Session is valid",
            data: {
                valid: true,
                cif: session.cif
            }
        });

    } catch (error) {
        console.error("[VERIFY_TRANSACTION_SESSION] Error:", error.message);
        res.status(500).json({
            error: true,
            message: "Transaction session verification failed"
        });
    }
});

// ============================================
// DESTROY SESSION (LOGOUT)
// Immediately invalidates the session on logout.
// Prevents session reuse after the user logs out.
// ============================================
router.post("/destroy-session", async (req, res) => {
    try {
        const { sessionToken } = req.body;

        if (!sessionToken || typeof sessionToken !== 'string') {
            return res.status(400).json({
                error: true,
                message: "Session token is required"
            });
        }

        // Delete the session from MongoDB immediately
        const result = await VerifiedSession.deleteOne({ session_token: sessionToken });

        if (result.deletedCount === 0) {
            // Session already expired or never existed — not an error
            return res.json({
                error: false,
                message: "Session already expired or not found"
            });
        }

        res.json({
            error: false,
            message: "Session destroyed successfully"
        });

    } catch (error) {
        console.error("[DESTROY_SESSION] Error:", error.message);
        res.status(500).json({
            error: true,
            message: "Failed to destroy session"
        });
    }
});

  export default router;


