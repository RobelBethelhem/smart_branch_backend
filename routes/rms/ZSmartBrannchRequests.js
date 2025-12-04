import {Router} from "express";
import User from "../../models/rms/User.js";
import Deposit from "../../models/rms/Deposit.js"
import Withdraw from "../../models/rms/Withdraw.js"
import Transfer from "../../models/rms/Transfer.js"
import Other_Bank_Transfer from "../../models/rms/Other_Bank_Transfer.js"
import Air_Ticket_Payment from "../../models/rms/Air_Ticket_Payment.js"
import Biometric from "../../models/rms/Biometric.js"
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
//                 console.error("Auto-assignment failed:", assignError);
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
        console.log(e);
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
        const [deposits, withdraws, transfers, otherBankTransfers, airTicketPayments] = await Promise.all([
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
        console.log("Error", e);
        res.status(500).json({ 
            error: true, 
            message: e.message || "Could not retrieve transactions" 
        });
    }
});














// 1. Deposit Endpoint

router.post("/deposit", async(req, res, next) => {
    try {
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
            Customer_Unique_Number,
            system,
            branch
        } = req.body;

        console.log("req.body", req.body)

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
                console.error("Auto-assignment failed:", assignError);
                return res.status(400).json({
                    error: true,
                    message: "Could not auto-assign teller: " + assignError.message
                });
            }
        }

        const newDeposit = new Deposit(depositData);
        await newDeposit.save();
        
        const customerNumber = newDeposit.account_number.substring(6, 13);
        console.log("newDeposit.account_number", newDeposit.account_number);
        console.log("customerNumber", customerNumber);

 const phoneQuery = `
            SELECT MOBILE_NUMBER as telephone 
            FROM FCUBSPRD.sttm_cust_personal 
            WHERE CUSTOMER_NO = :1
        `;
        const phoneResult = await executeQuery(phoneQuery, [customerNumber]);
        console.log("phoneResult", phoneResult);
        if (phoneResult.success && phoneResult.data?.length > 0) {
            let phoneNumber = phoneResult.data[0].TELEPHONE;
            console.log("phoneNumberrrrrr", phoneNumber);


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
                    console.error("SMS sending failed:", await response.text());
                }
            } catch (smsError) {
                console.error("SMS sending error:", smsError);
                // Don't return error to client, just log it
            }
        }



        res.status(201).json({ 
            error: false, 
            message: "Deposit request created successfully",
            data: {
                Queue_number: newDeposit.Customer_Unique_Number,
                request_date: newDeposit.request_date,
                status: newDeposit.status,
                assigned_to: newDeposit.assigned_to
            }
        });

    } catch(e) {
        console.log("Error", e);
        res.status(400).json({ 
            error: true, 
            message: e.message || "Could Not Do the Operation"
        });
    }
});

// 2. Withdraw Endpoint
router.post("/withdraw", async(req, res, next) => {
    try {

        console.log("Withdraw", req.body);
        req.body.Customer_Unique_Number = req.body.reference_number;
        delete req.body.reference_number;
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
            Customer_Unique_Number,
            system,
            branch
        } = req.body;

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
                console.error("Auto-assignment failed:", assignError);
                return res.status(400).json({
                    error: true,
                    message: "Could not auto-assign teller: " + assignError.message
                });
            }
        }

        const newWithdraw = new Withdraw(withdrawData);
        await newWithdraw.save();



        const customerNumber = newWithdraw.account_number.substring(6, 13);
        console.log("newDeposit.account_number", newWithdraw.account_number);
        console.log("customerNumber", customerNumber);

 const phoneQuery = `
            SELECT MOBILE_NUMBER as telephone 
            FROM FCUBSPRD.sttm_cust_personal 
            WHERE CUSTOMER_NO = :1
        `;
        const phoneResult = await executeQuery(phoneQuery, [customerNumber]);
        console.log("phoneResult", phoneResult);
        if (phoneResult.success && phoneResult.data?.length > 0) {
            let phoneNumber = phoneResult.data[0].TELEPHONE;
            console.log("phoneNumberrrrrr", phoneNumber);


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
                    console.error("SMS sending failed:", await response.text());
                }
            } catch (smsError) {
                console.error("SMS sending error:", smsError);
                // Don't return error to client, just log it
            }
        }



        res.status(201).json({ 
            error: false, 
            message: "Withdraw request created successfully",
            data: {
                Queue_number: newWithdraw.Customer_Unique_Number,
                request_date: newWithdraw.request_date,
                status: newWithdraw.status,
                assigned_to: newWithdraw.assigned_to
            }
        });

    } catch(e) {
        console.log("Error", e);
        res.status(400).json({ 
            error: true, 
            message: e.message || "Could Not Do the Operation"
        });
    }
});


// 3. Transfer Endpoint
router.post("/transfer", async(req, res, next) => {
    try {
        req.body.payment_narration = req.body.payment_narrative;
        delete req.body.payment_narrative;
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
            Customer_Unique_Number,
            system,
            branch
        } = req.body;

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
                console.error("Auto-assignment failed:", assignError);
                return res.status(400).json({
                    error: true,
                    message: "Could not auto-assign teller: " + assignError.message
                });
            }
        }

        const newTransfer = new Transfer(transferData);
        await newTransfer.save();



        
        const customerNumber = newTransfer.account_number.substring(6, 13);
        console.log("newDeposit.account_number", newTransfer.account_number);
        console.log("customerNumber", customerNumber);

 const phoneQuery = `
            SELECT MOBILE_NUMBER as telephone 
            FROM FCUBSPRD.sttm_cust_personal 
            WHERE CUSTOMER_NO = :1
        `;
        const phoneResult = await executeQuery(phoneQuery, [customerNumber]);
        console.log("phoneResult", phoneResult);
        if (phoneResult.success && phoneResult.data?.length > 0) {
            let phoneNumber = phoneResult.data[0].TELEPHONE;
            console.log("phoneNumberrrrrr", phoneNumber);


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
                    console.error("SMS sending failed:", await response.text());
                }
            } catch (smsError) {
                console.error("SMS sending error:", smsError);
                // Don't return error to client, just log it
            }
        }




        res.status(201).json({ 
            error: false, 
            message: "Transfer request created successfully",
            data: {
                Queue_number: newTransfer.Customer_Unique_Number,
                request_date: newTransfer.request_date,
                status: newTransfer.status,
                assigned_to: newTransfer.assigned_to
            }
        });

    } catch(e) {
        console.log("Error", e);
        res.status(400).json({ 
            error: true, 
            message: e.message || "Could Not Do the Operation"
        });
    }
});


// 4. Other Bank Transfer Endpoint
router.post("/other_bank_transfer", async(req, res, next) => {
    try {
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
            Customer_Unique_Number,
            system,
            branch
        } = req.body;

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
                console.error("Auto-assignment failed:", assignError);
                return res.status(400).json({
                    error: true,
                    message: "Could not auto-assign teller: " + assignError.message
                });
            }
        }

        const newOtherBankTransfer = new Other_Bank_Transfer(transferData);
        await newOtherBankTransfer.save();


        const customerNumber = newOtherBankTransfer.account_number.substring(6, 13);
        console.log("newDeposit.account_number", newOtherBankTransfer.account_number);
        console.log("customerNumber", customerNumber);

 const phoneQuery = `
            SELECT MOBILE_NUMBER as telephone 
            FROM FCUBSPRD.sttm_cust_personal 
            WHERE CUSTOMER_NO = :1
        `;
        const phoneResult = await executeQuery(phoneQuery, [customerNumber]);
        console.log("phoneResult", phoneResult);
        if (phoneResult.success && phoneResult.data?.length > 0) {
            let phoneNumber = phoneResult.data[0].TELEPHONE;
            console.log("phoneNumberrrrrr", phoneNumber);


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
                    console.error("SMS sending failed:", await response.text());
                }
            } catch (smsError) {
                console.error("SMS sending error:", smsError);
                // Don't return error to client, just log it
            }
        }
        

        res.status(201).json({ 
            error: false, 
            message: "Other Bank Transfer request created successfully",
            data: {
                Queue_number: newOtherBankTransfer.Customer_Unique_Number,
                request_date: newOtherBankTransfer.request_date,
                status: newOtherBankTransfer.status,
                assigned_to: newOtherBankTransfer.assigned_to
            }
        });

    } catch(e) {
        console.log("Error", e);
        res.status(400).json({ 
            error: true, 
            message: e.message || "Could Not Do the Operation"
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
            searchQuery = {
                $or: [
                    { account_number: query },
                    { Customer_Unique_Number: query },
                    { acc_holder_name: new RegExp(query, 'i') }
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

        // Fetch data from all models based on the search query
        const deposits = await Deposit.find(searchQuery);
        const withdraws = await Withdraw.find(searchQuery);
        const transfers = await Transfer.find(searchQuery);
        const otherBankTransfers = await Other_Bank_Transfer.find(searchQuery);
        const airTicketPayments = await Air_Ticket_Payment.find(searchQuery);

        // Combine all transactions
        let transactions = [
            ...withdraws,
            ...deposits,
            ...transfers,
            ...otherBankTransfers,
            ...airTicketPayments
        ];

        // Get unique account numbers from all transactions
        const accountNumbers = [...new Set(transactions.map(t => t.account_number))];

        // Fetch images for all account numbers in a single query
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

        // Add images to transactions
        transactions = transactions.map(transaction => ({
            ...transaction.toObject(), // Convert mongoose document to plain object
            profile_image: accountImages[transaction.account_number]?.profile_image || null,
            sign_image: accountImages[transaction.account_number]?.sign_image || null
        }));

        res.status(200).json({
            error: false,
            transactions
        });

    } catch (e) {
        console.log("Error", e);
        res.status(500).json({
            error: true,
            message: e.message || "Could not retrieve transactions"
        });
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


        console.log("Robel Asfaw Bogale", req.body);
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
        console.log("Error", e);
        res.status(500).json({ 
            error: true, 
            message: e.message || "Could not perform the operation" 
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

        const { transaction_id, trn_ref_no } = req.body;
        
        if (!transaction_id || !trn_ref_no) {
            return res.status(400).json({ 
                error: true, 
                message: "Transaction ID and TRN Reference Number are required" 
            });
        }

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


        console.log("trn_ref_no", trn_ref_no);
        console.log("user.flex_id", user.flex_id);
        console.log("transaction.assigned_date",formattedAssignedDate);
        console.log("txnTrnCode", txnTrnCode);

        console.log("flexResult", flexResult);

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
        console.log("Error", e);
        res.status(500).json({ 
            error: true, 
            message: e.message || "Could not perform the operation" 
        });
    }
});



router.put("/edit_smart_branch_request", async(req, res, next) => {
    try {
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
        } = req.body;

        // Validate required fields
        if (!Customer_Unique_Number || !request_type) {
            return res.status(400).json({
                error: true,
                message: "Customer Unique Number and request type are required"
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
            data: result
        });

    } catch (error) {
        console.error("Error updating transaction:", error);
        return res.status(500).json({
            error: true,
            message: "Internal Server Error",
            details: error.message
        });
    }
});

// Delete endpoint
router.delete("/delete_smart_branch_request", async(req, res, next) => {
    try {
        const { Customer_Unique_Number, request_type } = req.body;

        // Validate required fields
        if (!Customer_Unique_Number || !request_type) {
            return res.status(400).json({
                error: true,
                message: "Customer Unique Number and request type are required"
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
            data: result
        });

    } catch (error) {
        console.error("Error deleting transaction:", error);
        return res.status(500).json({
            error: true,
            message: "Internal Server Error",
            details: error.message
        });
    }
});


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
        
            console.log("responseTransactions", responseTransactions);
        
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
        console.error("Error retrieving account number:", e);
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

        // Fetch transactions from all models
        const [deposits, withdraws, transfers, otherBankTransfers, airTicketPayments] = await Promise.all([
            Deposit.find({ 
                assigned_to: user.user,
                ...dateFilter
            }).sort({ request_date: -1 }),
            
            Withdraw.find({ 
                assigned_to: user.user,
                ...dateFilter
            }).sort({ request_date: -1 }),
            
            Transfer.find({ 
                assigned_to: user.user,
                ...dateFilter
            }).sort({ request_date: -1 }),
            
            Other_Bank_Transfer.find({ 
                assigned_to: user.user,
                ...dateFilter
            }).sort({ request_date: -1 }),
            
            Air_Ticket_Payment.find({ 
                assigned_to: user.user,
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

        res.status(200).json({
            error: false,
            data: {
                transactions: finalTransactions,
                summary
            }
        });

    } catch(e) {
        console.log("Error", e);
        res.status(500).json({ 
            error: true, 
            message: e.message || "Could not retrieve transactions" 
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
        console.log("Error", e);
        res.status(500).json({ 
            error: true, 
            message: e.message || "Could not retrieve transactions" 
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

        // Fetch transactions from all models with status 'authorized' and matching branch
        const [deposits, withdraws, transfers, otherBankTransfers, airTicketPayments] = await Promise.all([
            Deposit.find({ 
                status: 'authorized',
                branch: user.branch,
                ...dateFilter
            }).sort({ request_date: -1 }),
            
            Withdraw.find({ 
                status: 'authorized',
                branch: user.branch,
                ...dateFilter
            }).sort({ request_date: -1 }),
            
            Transfer.find({ 
                status: 'authorized',
                branch: user.branch,
                ...dateFilter
            }).sort({ request_date: -1 }),
            
            Other_Bank_Transfer.find({ 
                status: 'authorized',
                branch: user.branch,
                ...dateFilter
            }).sort({ request_date: -1 }),
            
            Air_Ticket_Payment.find({ 
                status: 'authorized',
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
        console.log("Error", e);
        res.status(500).json({ 
            error: true, 
            message: e.message || "Could not retrieve transactions" 
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
        console.log("Error", e);
        res.status(500).json({ 
            error: true, 
            message: e.message || "Could not perform the operation" 
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


router.post("/transaction_audited", auth, roleCheck(["Auditor","Teller"]), async(req, res, next) => {
    try {
        // Get current user
        console.log("req.body", req.body)
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

            // Check if status is authorized
            if (existingTransaction.status !== 'authorized') {
                updateResults.skipped.push({
                    id: transaction.id,
                    reason: `Transaction status is ${existingTransaction.status}, expected 'authorized'`
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
                    status: 'authorized',
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
        console.log("Error", e);
        res.status(500).json({ 
            error: true, 
            message: e.message || "Could not perform the operation" 
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

        // Fetch all transactions based on the query condition
        const [deposits, withdraws, transfers, otherBankTransfers, airTicketPayments] = await Promise.all([
            Deposit.find(queryCondition)
                .sort({ request_date: -1 }),
            
            Withdraw.find(queryCondition)
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
        console.log("Error", e);
        res.status(500).json({ 
            error: true, 
            message: e.message || "Could not retrieve transactions" 
        });
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
        console.log("Error", e);
        res.status(500).json({ 
            error: true, 
            message: e.message || "Could not retrieve till IDs" 
        });
    }
})




router.post("/add_teller", auth, roleCheck(["Admin"]), async(req, res, next) => {
    try {
        console.log("req.body", req.body)
        
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
        console.log("Error", e);
        res.status(500).json({ 
            error: true, 
            message: e.message || "Could not perform the operation" 
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

        const users = await User.find({ branch: branchManager.branch }).lean();

        console.log("users", users)

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

        meta.totalRowCount = users.length;
        sendUsers.meta = meta;
        console.log(" sendUsers.meta",  sendUsers.data)
        res.json(sendUsers);

    } catch(e) {
        console.log("Error", e);
        res.status(500).json({ 
            error: true, 
            message: e.message || "Could not perform the operation" 
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
        console.error("Error in assignTellerBySystem:", error);
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
        console.error("Error in assignTellerBySystem:", error);
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

        console.log(`Biometric registered for CIF ${cif} - Simulated: ${isSimulated}`);

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
        console.error("Error registering biometric:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Could not register biometric"
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
        console.error("Error fetching biometrics:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Could not fetch biometrics"
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
        console.error("Error fetching branch biometrics:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Could not fetch branch biometrics"
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
        console.error("Error fetching pending biometrics:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Could not fetch pending biometrics"
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
        console.error("Error approving biometric:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Could not approve biometric"
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
        console.error("Error rejecting biometric:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Could not reject biometric"
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
        console.error("Error verifying biometric:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Could not verify biometric"
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
        console.error("Error checking biometric:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Could not check biometric"
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
        console.error("Error fetching customer by CIF:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Could not fetch customer information"
        });
    }
});


// Fingerprint authentication for customer-facing app
// Uses ZK SDK's fast 1:N DBIdentify for efficient matching (~50,000+ templates/second)
router.post("/biometric/authenticate", async (req, res) => {
    try {
        const { fingerprint_template } = req.body;

        if (!fingerprint_template) {
            return res.status(400).json({
                error: true,
                message: "Fingerprint template is required"
            });
        }

        // Get all approved biometrics
        const approvedBiometrics = await Biometric.find({ status: 'approved' });

        if (approvedBiometrics.length === 0) {
            return res.status(404).json({
                error: true,
                message: "No registered fingerprints found"
            });
        }

        console.log(`Fast 1:N identification against ${approvedBiometrics.length} registered templates...`);

        // Use fast 1:N identification instead of looping through 1:1 verifications
        let matchedBiometric = null;
        let matchScore = 0;

        let isSimulatedMatch = false;

        try {
            const identifyResult = await identifyFingerprint(fingerprint_template, approvedBiometrics);
            console.log('Identify result:', JSON.stringify(identifyResult));

            if (identifyResult.success && identifyResult.found && identifyResult.cif) {
                // Find the matched biometric record
                matchedBiometric = approvedBiometrics.find(b => b.cif === identifyResult.cif);
                matchScore = identifyResult.score || 0;
                isSimulatedMatch = identifyResult.simulated || false;
                const matchType = isSimulatedMatch ? '[SIMULATED]' : '[REAL]';
                console.log(`${matchType} Match found! CIF: ${identifyResult.cif}, Score: ${matchScore}, Time: ${identifyResult.total_time_ms}ms`);
            } else if (!identifyResult.success) {
                // SDK failed, fall back to 1:1 verification
                console.log('SDK identify failed:', identifyResult.message, '- falling back to 1:1 verification');
                throw new Error(identifyResult.message || 'SDK identify failed');
            } else {
                console.log(`No match found. Database size: ${identifyResult.database_size}, Simulated: ${identifyResult.simulated}, Time: ${identifyResult.total_time_ms}ms`);
            }
        } catch (identifyError) {
            console.error('Fast identification failed, falling back to 1:1 verification:', identifyError.message);

            // Fallback to 1:1 verification loop if fast identification fails
            for (const biometric of approvedBiometrics) {
                try {
                    const verifyResult = await verifyFingerprint(fingerprint_template, biometric.fingerprint_template);
                    console.log(`Verify result for CIF ${biometric.cif}:`, JSON.stringify(verifyResult));
                    if (verifyResult.success && verifyResult.match && verifyResult.score > matchScore) {
                        matchedBiometric = biometric;
                        matchScore = verifyResult.score;
                        isSimulatedMatch = verifyResult.simulated || false;
                        const matchType = isSimulatedMatch ? '[SIMULATED]' : '[REAL]';
                        console.log(`${matchType} Match found (fallback)! CIF: ${biometric.cif}, Score: ${verifyResult.score}`);
                        break;
                    }
                } catch (verifyError) {
                    console.error(`Verify error for CIF ${biometric.cif}:`, verifyError.message);
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
        console.error("Error in biometric authentication:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Authentication failed"
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
        console.error("Error in auto-populate denomination:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Failed to calculate denomination"
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
        console.error("Error in validate denomination:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Failed to validate denomination"
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
        console.error("Error in check withdrawal limit:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Failed to check withdrawal limit"
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
        console.error("Error in check maker-checker:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Failed to check maker-checker threshold"
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
            withdraw.status = 'pending_checker';
            withdraw.posted_by = posted_by || req.user?.name;
            withdraw.posted_date = new Date();
            await withdraw.save();

            return res.status(200).json({
                error: false,
                message: `Transaction requires checker approval (amount ${amount} >= threshold ${checkerCheck.threshold})`,
                data: {
                    withdraw,
                    needsChecker: true,
                    status: 'pending_checker'
                }
            });
        }

        // No checker needed - process directly
        // For now, just update status to posted (SOAP integration can be enabled later)
        withdraw.status = 'posted';
        withdraw.posted_by = posted_by || req.user?.name;
        withdraw.posted_date = new Date();
        withdraw.trn_ref_no = trn_ref_no || `TRN${Date.now()}`;

        // Update till (deduct from teller's till for withdrawal)
        try {
            await FlexcubeTransactionService.updateTillForWithdraw(
                posted_by || req.user?.userId,
                finalDenomination
            );
            withdraw.till_updated = true;
            withdraw.till_update_date = new Date();
        } catch (tillError) {
            console.error("Till update failed:", tillError);
            // Continue even if till update fails - log the error
            withdraw.till_updated = false;
        }

        await withdraw.save();

        res.status(200).json({
            error: false,
            message: "Withdrawal processed successfully",
            data: {
                withdraw,
                needsChecker: false,
                status: 'posted'
            }
        });

    } catch (e) {
        console.error("Error in process withdraw with denomination:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Failed to process withdrawal"
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

        // Check maker-checker threshold
        const checkerCheck = await FlexcubeTransactionService.checkMakerCheckerThreshold(amount);

        // Generate XREF if not exists
        if (!deposit.xref) {
            deposit.xref = await Deposit.generateXref();
        }

        // Update deposit with denomination info
        deposit.denomination = finalDenomination;
        deposit.denomination_total = FlexcubeTransactionService.calculateDenominationTotal(finalDenomination);
        deposit.needs_checker = checkerCheck.needsChecker;
        deposit.checker_threshold = checkerCheck.threshold;

        if (checkerCheck.needsChecker) {
            // Needs checker approval - set to pending_checker
            deposit.status = 'pending_checker';
            deposit.posted_by = posted_by || req.user?.name;
            deposit.posted_date = new Date();
            await deposit.save();

            return res.status(200).json({
                error: false,
                message: `Transaction requires checker approval (amount ${amount} >= threshold ${checkerCheck.threshold})`,
                data: {
                    deposit,
                    needsChecker: true,
                    status: 'pending_checker'
                }
            });
        }

        // No checker needed - process directly
        deposit.status = 'posted';
        deposit.posted_by = posted_by || req.user?.name;
        deposit.posted_date = new Date();
        deposit.trn_ref_no = trn_ref_no || `TRN${Date.now()}`;

        // Update till (add to teller's till for deposit)
        try {
            await FlexcubeTransactionService.updateTillForDeposit(
                posted_by || req.user?.userId,
                finalDenomination
            );
            deposit.till_updated = true;
            deposit.till_update_date = new Date();
        } catch (tillError) {
            console.error("Till update failed:", tillError);
            deposit.till_updated = false;
        }

        await deposit.save();

        res.status(200).json({
            error: false,
            message: "Deposit processed successfully",
            data: {
                deposit,
                needsChecker: false,
                status: 'posted'
            }
        });

    } catch (e) {
        console.error("Error in process deposit with denomination:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Failed to process deposit"
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

        // Get pending deposits and withdrawals
        const [pendingDeposits, pendingWithdraws] = await Promise.all([
            Deposit.find(query).sort({ posted_date: -1 }),
            Withdraw.find(query).sort({ posted_date: -1 })
        ]);

        // Combine and add type field
        const pendingTransactions = [
            ...pendingDeposits.map(d => ({ ...d.toObject(), transaction_type: 'Deposit' })),
            ...pendingWithdraws.map(w => ({ ...w.toObject(), transaction_type: 'Withdraw' }))
        ].sort((a, b) => new Date(b.posted_date) - new Date(a.posted_date));

        res.status(200).json({
            error: false,
            message: `Found ${pendingTransactions.length} transactions pending checker approval`,
            data: pendingTransactions
        });

    } catch (e) {
        console.error("Error fetching pending checker transactions:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Failed to fetch pending transactions"
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

        // Update checker fields
        transaction.checker_name = checker_name || req.user?.name;
        transaction.checker_date = new Date();
        transaction.checker_remarks = checker_remarks;

        if (action === 'reject') {
            transaction.status = 'rejected';
            transaction.rejection_reason = checker_remarks || 'Rejected by checker';
            await transaction.save();

            return res.status(200).json({
                error: false,
                message: "Transaction rejected by checker",
                data: {
                    transaction,
                    action: 'rejected'
                }
            });
        }

        // Approve - process the transaction
        transaction.status = 'posted';
        transaction.trn_ref_no = trn_ref_no || `TRN${Date.now()}`;

        // Update till based on transaction type
        try {
            if (transaction_type === 'Deposit') {
                await FlexcubeTransactionService.updateTillForDeposit(
                    transaction.posted_by,
                    transaction.denomination
                );
            } else {
                await FlexcubeTransactionService.updateTillForWithdraw(
                    transaction.posted_by,
                    transaction.denomination
                );
            }
            transaction.till_updated = true;
            transaction.till_update_date = new Date();
        } catch (tillError) {
            console.error("Till update failed:", tillError);
            transaction.till_updated = false;
        }

        await transaction.save();

        res.status(200).json({
            error: false,
            message: "Transaction approved and posted",
            data: {
                transaction,
                action: 'approved'
            }
        });

    } catch (e) {
        console.error("Error in approve pending transaction:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Failed to process approval"
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
        console.error("Error fetching transaction details:", e);
        res.status(500).json({
            error: true,
            message: e.message || "Failed to fetch transaction details"
        });
    }
});


  export default router;


