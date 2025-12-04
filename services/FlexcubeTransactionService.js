/**
 * FlexcubeTransactionService.js
 *
 * Service for handling Flexcube SOAP transactions including:
 * - Daily withdrawal limit checking
 * - SOAP transaction creation (Deposit, Withdraw, Transfer)
 * - Till update management
 * - Maker-checker threshold enforcement
 */

import { executeQuery, executeTransaction } from '../lib/db.js';
import CustomerCategoryLimit from '../models/rms/CustomerCategoryLimit.js';
import MakerCheckerThreshold from '../models/rms/MakerCheckerThreshold.js';
import XrefCounter from '../models/rms/XrefCounter.js';

// ============================================
// UTILITY FUNCTIONS
// ============================================

/**
 * Extract CIF from 16-digit account number
 * Account format: 1234567899876543
 * CIF extraction: exclude last 3 digits (543), then from right take 7 digits (7899876)
 */
export function extractCifFromAccount(accountNumber) {
    if (!accountNumber || accountNumber.length !== 16) {
        return null;
    }
    const withoutLast3 = accountNumber.slice(0, -3); // 1234567899876
    return withoutLast3.slice(-7); // 7899876
}

/**
 * Get branch code from 16-digit account number (first 3 digits)
 */
export function extractBranchFromAccount(accountNumber) {
    if (!accountNumber || accountNumber.length < 3) {
        return null;
    }
    return accountNumber.substring(0, 3);
}

/**
 * Calculate total from denomination object
 */
export function calculateDenominationTotal(denomination) {
    if (!denomination) return 0;
    return (
        (denomination.d200 || 0) * 200 +
        (denomination.d100 || 0) * 100 +
        (denomination.d50 || 0) * 50 +
        (denomination.d10 || 0) * 10 +
        (denomination.d5 || 0) * 5 +
        (denomination.d1 || 0) * 1 +
        (denomination.dc50 || 0) * 0.50 +
        (denomination.dc25 || 0) * 0.25 +
        (denomination.dc10 || 0) * 0.10 +
        (denomination.dc5 || 0) * 0.05 +
        (denomination.dc1 || 0) * 0.01
    );
}

/**
 * Auto-populate denomination based on amount (greedy algorithm)
 */
export function autopopulateDenomination(amount) {
    const denominations = [
        { key: 'd200', value: 200 },
        { key: 'd100', value: 100 },
        { key: 'd50', value: 50 },
        { key: 'd10', value: 10 },
        { key: 'd5', value: 5 },
        { key: 'd1', value: 1 },
        { key: 'dc50', value: 0.50 },
        { key: 'dc25', value: 0.25 },
        { key: 'dc10', value: 0.10 },
        { key: 'dc5', value: 0.05 },
        { key: 'dc1', value: 0.01 },
    ];

    let remaining = Math.round(amount * 100) / 100;
    const result = {};

    for (const { key, value } of denominations) {
        if (remaining >= value) {
            result[key] = Math.floor(remaining / value);
            remaining = Math.round((remaining - result[key] * value) * 100) / 100;
        } else {
            result[key] = 0;
        }
    }

    return result;
}

// ============================================
// LIMIT CHECKING FUNCTIONS
// ============================================

/**
 * Get customer category from Flexcube by CIF
 */
export async function getCustomerCategory(cif) {
    const query = `SELECT CUSTOMER_CATEGORY FROM sttm_customer WHERE CUSTOMER_NO = :1`;
    const result = await executeQuery(query, [cif]);

    if (!result.success || !result.data?.length) {
        return { success: false, error: 'Customer not found in Flexcube', category: null };
    }

    return {
        success: true,
        category: result.data[0].CUSTOMER_CATEGORY
    };
}

/**
 * Get total daily withdrawal amount for a customer (CIF)
 * Uses actb_daily_log to sum today's withdrawals excluding reversed transactions
 */
export async function getDailyWithdrawalTotal(cif) {
    const query = `
        SELECT
            NVL(SUM(A.LCY_AMOUNT), 0) AS TOTAL_LCY_AMOUNT
        FROM fcubsprd.actb_daily_log A
        JOIN fcubsprd.cstm_product P ON A.product = P.product_code
        WHERE A.DRCR_IND = 'D'
          AND P.product_group = 'CASHLM'
          AND A.AC_CCY = 'ETB'
          AND A.RELATED_CUSTOMER = :1
          AND A.CUST_GL = 'A'
          AND TRUNC(A.TRN_DT) = TRUNC(SYSDATE)
          AND A.trn_ref_no NOT IN (
                SELECT AL.trn_ref_no
                FROM fcubsprd.actb_daily_log AL
                WHERE AL.event = 'REVR'
                  AND AL.ac_no = A.ac_no
          )
    `;

    const result = await executeQuery(query, [cif]);

    if (!result.success) {
        console.error('Error fetching daily withdrawal total:', result.error);
        return { success: false, error: result.error, total: 0 };
    }

    return {
        success: true,
        total: result.data?.[0]?.TOTAL_LCY_AMOUNT || 0
    };
}

/**
 * Get customer category daily limit from MongoDB
 */
export async function getCategoryDailyLimit(category) {
    try {
        const limit = await CustomerCategoryLimit.findOne({
            customer_category: category,
            is_active: true
        });

        if (!limit) {
            return { success: true, limit: null, configured: false };
        }

        return {
            success: true,
            limit: limit.daily_limit,
            configured: true,
            data: limit
        };
    } catch (error) {
        console.error('Error fetching category limit:', error);
        return { success: false, error: error.message, limit: null };
    }
}

/**
 * Check if withdrawal exceeds daily limit
 * Returns: { allowed: boolean, reason: string, details: object }
 */
export async function checkWithdrawalLimit(accountNumber, withdrawAmount) {
    const cif = extractCifFromAccount(accountNumber);
    if (!cif) {
        return {
            allowed: false,
            reason: 'Invalid account number format',
            details: { accountNumber }
        };
    }

    // 1. Get customer category from Flexcube
    const categoryResult = await getCustomerCategory(cif);
    if (!categoryResult.success) {
        // If we can't get category, we might want to allow the transaction
        // or block it - configurable behavior
        console.warn('Could not fetch customer category:', categoryResult.error);
        return {
            allowed: true,
            reason: 'Customer category lookup failed - proceeding without limit check',
            details: { cif, error: categoryResult.error },
            category: null,
            dailyLimit: null,
            dailyWithdrawn: null,
            limitConfigured: false
        };
    }

    const customerCategory = categoryResult.category;

    // 2. Get category daily limit from MongoDB
    const limitResult = await getCategoryDailyLimit(customerCategory);
    if (!limitResult.success) {
        return {
            allowed: true,
            reason: 'Limit configuration lookup failed - proceeding without limit check',
            details: { cif, category: customerCategory, error: limitResult.error },
            category: customerCategory,
            dailyLimit: null,
            dailyWithdrawn: null,
            limitConfigured: false
        };
    }

    if (!limitResult.configured) {
        // No limit configured for this category - allow transaction
        return {
            allowed: true,
            reason: 'No daily limit configured for this customer category',
            details: { cif, category: customerCategory },
            category: customerCategory,
            dailyLimit: null,
            dailyWithdrawn: null,
            limitConfigured: false
        };
    }

    const dailyLimit = limitResult.limit;

    // 3. Get today's total withdrawal from Flexcube
    const withdrawalResult = await getDailyWithdrawalTotal(cif);
    if (!withdrawalResult.success) {
        console.warn('Could not fetch daily withdrawal total:', withdrawalResult.error);
        // Proceed with caution - might want to block in production
        return {
            allowed: true,
            reason: 'Daily withdrawal lookup failed - proceeding without limit check',
            details: { cif, category: customerCategory, dailyLimit, error: withdrawalResult.error },
            category: customerCategory,
            dailyLimit: dailyLimit,
            dailyWithdrawn: null,
            limitConfigured: true
        };
    }

    const dailyWithdrawn = withdrawalResult.total;
    const newTotal = dailyWithdrawn + withdrawAmount;

    // 4. Check if new withdrawal would exceed limit
    if (newTotal > dailyLimit) {
        const remainingLimit = Math.max(0, dailyLimit - dailyWithdrawn);
        return {
            allowed: false,
            reason: `Daily withdrawal limit exceeded. Limit: ETB ${dailyLimit.toLocaleString()}, Already withdrawn: ETB ${dailyWithdrawn.toLocaleString()}, Remaining: ETB ${remainingLimit.toLocaleString()}, Requested: ETB ${withdrawAmount.toLocaleString()}`,
            details: {
                cif,
                category: customerCategory,
                dailyLimit,
                dailyWithdrawn,
                requestedAmount: withdrawAmount,
                newTotal,
                remainingLimit
            },
            category: customerCategory,
            dailyLimit: dailyLimit,
            dailyWithdrawn: dailyWithdrawn,
            limitConfigured: true
        };
    }

    return {
        allowed: true,
        reason: 'Withdrawal within daily limit',
        details: {
            cif,
            category: customerCategory,
            dailyLimit,
            dailyWithdrawn,
            requestedAmount: withdrawAmount,
            newTotal,
            remainingLimit: dailyLimit - newTotal
        },
        category: customerCategory,
        dailyLimit: dailyLimit,
        dailyWithdrawn: dailyWithdrawn,
        limitConfigured: true
    };
}

// ============================================
// MAKER-CHECKER THRESHOLD FUNCTIONS
// ============================================

/**
 * Check if amount requires checker approval based on threshold
 */
export async function checkMakerCheckerThreshold(amount, currency = 'ETB') {
    try {
        const threshold = await MakerCheckerThreshold.findOne({
            is_active: true,
            currency: currency
        });

        if (!threshold) {
            // No threshold configured - all transactions need checker
            return {
                needsChecker: true,
                reason: 'No maker-checker threshold configured - all transactions require checker approval',
                thresholdAmount: 0,
                configured: false
            };
        }

        const needsChecker = amount >= threshold.threshold_amount;

        return {
            needsChecker,
            reason: needsChecker
                ? `Amount (ETB ${amount.toLocaleString()}) >= threshold (ETB ${threshold.threshold_amount.toLocaleString()}) - requires checker approval`
                : `Amount (ETB ${amount.toLocaleString()}) < threshold (ETB ${threshold.threshold_amount.toLocaleString()}) - can be auto-authorized`,
            thresholdAmount: threshold.threshold_amount,
            configured: true
        };
    } catch (error) {
        console.error('Error checking maker-checker threshold:', error);
        // Default to requiring checker on error
        return {
            needsChecker: true,
            reason: 'Error checking threshold - requiring checker approval',
            thresholdAmount: 0,
            configured: false,
            error: error.message
        };
    }
}

// ============================================
// SOAP TRANSACTION FUNCTIONS
// ============================================

/**
 * Build SOAP message for Flexcube CreateTransaction
 * @param {Object} params Transaction parameters
 * @returns {string} SOAP XML message
 */
export function buildCreateTransactionSOAP(params) {
    const {
        product = 'ETAL',         // Product code
        branch,                    // Transaction branch
        txnBranch,                // Teller branch
        txnAccount,               // Transaction account (customer account)
        txnCurrency = 'ETB',
        txnAmount,
        txnCode = 'FTT',          // Transaction code (FTT for transfer, CDP for deposit, CWL for withdraw)
        offsetBranch,             // Offset branch (GL account branch)
        offsetAccount,            // Offset account (GL account or other customer account)
        offsetCurrency = 'ETB',
        offsetAmount,
        offsetCode = 'FTT',       // Offset transaction code
        userId = 'IB_SER',
        source = 'EXTIB'
    } = params;

    return `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:fcub="http://fcubs.ofss.com/service/FCUBSRTService">
    <soapenv:Header/>
    <soapenv:Body>
        <fcub:CREATETRANSACTION_FSFS_REQ>
            <fcub:FCUBS_HEADER>
                <fcub:SOURCE>${source}</fcub:SOURCE>
                <fcub:UBSCOMP>FCUBS</fcub:UBSCOMP>
                <fcub:USERID>${userId}</fcub:USERID>
                <fcub:BRANCH>${branch}</fcub:BRANCH>
                <fcub:SERVICE>FCUBSRTService</fcub:SERVICE>
                <fcub:OPERATION>CreateTransaction</fcub:OPERATION>
            </fcub:FCUBS_HEADER>
            <fcub:FCUBS_BODY>
                <fcub:Transaction-Details>
                    <fcub:PRD>${product}</fcub:PRD>
                    <fcub:BRN>${branch}</fcub:BRN>
                    <fcub:TXNBRN>${txnBranch}</fcub:TXNBRN>
                    <fcub:TXNACC>${txnAccount}</fcub:TXNACC>
                    <fcub:TXNCCY>${txnCurrency}</fcub:TXNCCY>
                    <fcub:TXNAMT>${txnAmount}</fcub:TXNAMT>
                    <fcub:TXNTRN>${txnCode}</fcub:TXNTRN>
                    <fcub:OFFSETBRN>${offsetBranch}</fcub:OFFSETBRN>
                    <fcub:OFFSETACC>${offsetAccount}</fcub:OFFSETACC>
                    <fcub:OFFSETCCY>${offsetCurrency}</fcub:OFFSETCCY>
                    <fcub:OFFSETAMT>${offsetAmount || txnAmount}</fcub:OFFSETAMT>
                    <fcub:OFFSETTRN>${offsetCode}</fcub:OFFSETTRN>
                </fcub:Transaction-Details>
            </fcub:FCUBS_BODY>
        </fcub:CREATETRANSACTION_FSFS_REQ>
    </soapenv:Body>
</soapenv:Envelope>`;
}

/**
 * Execute SOAP transaction to Flexcube
 * Note: This requires actual SOAP client implementation
 */
export async function executeFlexcubeTransaction(soapMessage, endpoint = null) {
    // Default endpoint - should be configured in environment
    const flexcubeEndpoint = endpoint || process.env.FLEXCUBE_RT_SERVICE_URL ||
        'http://10.1.2.138:7004/soa-infra/services/default/FCUBSRTService/fcubsrtserviceprocess_client_ep?WSDL';

    try {
        // In a real implementation, this would use a SOAP client like 'soap' npm package
        // For now, we'll use fetch with raw XML
        const response = await fetch(flexcubeEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml;charset=UTF-8',
                'SOAPAction': '"CreateTransaction"'
            },
            body: soapMessage
        });

        const responseText = await response.text();

        // Parse response to check for success/failure
        const isSuccess = responseText.includes('<ns0:MSGSTAT>SUCCESS</ns0:MSGSTAT>') ||
                          responseText.includes('MSGSTAT>SUCCESS<');

        // Extract transaction reference if available
        let trnRefNo = null;
        const trnRefMatch = responseText.match(/<ns0:TRN_REF_NO>([^<]+)<\/ns0:TRN_REF_NO>/);
        if (trnRefMatch) {
            trnRefNo = trnRefMatch[1];
        }

        return {
            success: isSuccess,
            trnRefNo,
            rawResponse: responseText,
            error: isSuccess ? null : 'Transaction failed - check rawResponse for details'
        };
    } catch (error) {
        console.error('SOAP transaction error:', error);
        return {
            success: false,
            error: error.message,
            rawResponse: null
        };
    }
}

/**
 * Create Deposit transaction (Credit customer account, Debit GL)
 */
export async function createDepositTransaction(params) {
    const {
        customerAccount,
        amount,
        tellerBranch,
        glAccount = '1031110049409011', // Default GL account for cash
        denomination
    } = params;

    const customerBranch = extractBranchFromAccount(customerAccount);

    const soapParams = {
        product: 'ETAL',
        branch: customerBranch,
        txnBranch: tellerBranch,
        txnAccount: glAccount,           // Debit GL account
        txnAmount: amount,
        txnCode: 'FTT',
        offsetBranch: customerBranch,
        offsetAccount: customerAccount,  // Credit customer account
        offsetAmount: amount,
        offsetCode: 'FTT'
    };

    const soapMessage = buildCreateTransactionSOAP(soapParams);
    return await executeFlexcubeTransaction(soapMessage);
}

/**
 * Create Withdraw transaction (Debit customer account, Credit GL)
 * This is the reverse of deposit
 */
export async function createWithdrawTransaction(params) {
    const {
        customerAccount,
        amount,
        tellerBranch,
        glAccount = '1031110049409011', // Default GL account for cash
        denomination
    } = params;

    const customerBranch = extractBranchFromAccount(customerAccount);

    const soapParams = {
        product: 'ETAL',
        branch: customerBranch,
        txnBranch: tellerBranch,
        txnAccount: customerAccount,     // Debit customer account
        txnAmount: amount,
        txnCode: 'FTT',
        offsetBranch: '103',             // GL branch (usually head office)
        offsetAccount: glAccount,        // Credit GL account
        offsetAmount: amount,
        offsetCode: 'FTT'
    };

    const soapMessage = buildCreateTransactionSOAP(soapParams);
    return await executeFlexcubeTransaction(soapMessage);
}

/**
 * Create Transfer transaction (Debit customer account, Credit beneficiary account)
 * No till update needed for transfers
 */
export async function createTransferTransaction(params) {
    const {
        fromAccount,
        toAccount,
        amount,
        tellerBranch
    } = params;

    const fromBranch = extractBranchFromAccount(fromAccount);
    const toBranch = extractBranchFromAccount(toAccount);

    const soapParams = {
        product: 'ETAL',
        branch: fromBranch,
        txnBranch: tellerBranch,
        txnAccount: fromAccount,         // Debit source account
        txnAmount: amount,
        txnCode: 'FTT',
        offsetBranch: toBranch,
        offsetAccount: toAccount,        // Credit destination account
        offsetAmount: amount,
        offsetCode: 'FTT'
    };

    const soapMessage = buildCreateTransactionSOAP(soapParams);
    return await executeFlexcubeTransaction(soapMessage);
}

// ============================================
// TILL UPDATE FUNCTIONS
// ============================================

/**
 * Update till denominations for deposit (inflow)
 * @param {string} userId - The Flexcube user ID
 * @param {Object} denomination - Denomination breakdown
 */
export async function updateTillForDeposit(userId, denomination) {
    if (!denomination) return { success: true, message: 'No denomination to update' };

    const updates = [];
    const denomMap = [
        { field: 'd200', value: 200 },
        { field: 'd100', value: 100 },
        { field: 'd50', value: 50 },
        { field: 'd10', value: 10 },
        { field: 'd5', value: 5 },
        { field: 'd1', value: 1 },
        { field: 'dc50', value: 0.5 },
        { field: 'dc25', value: 0.25 },
        { field: 'dc10', value: 0.1 },
        { field: 'dc5', value: 0.05 },
        { field: 'dc1', value: 0.01 },
    ];

    for (const { field, value } of denomMap) {
        const count = denomination[field] || 0;
        if (count > 0) {
            // Update DENOMCOUNT and INFLOW
            updates.push({
                query: `UPDATE FCUBSPRD.fbtb_till_detail_ccy
                        SET DENOMCOUNT = DENOMCOUNT + :1, INFLOW = INFLOW + :1
                        WHERE denomcode = (
                            SELECT denomcode FROM FCUBSPRD.fbtb_till_detail_ccy
                            WHERE till_id = (SELECT TILL_ID FROM FCUBSPRD.smtb_user_tills WHERE user_id = UPPER(:2))
                            AND denomval = :3 AND ccycode = 'ETB'
                            ORDER BY denomcode ASC FETCH FIRST 1 ROWS ONLY
                        )
                        AND till_id = (SELECT TILL_ID FROM FCUBSPRD.smtb_user_tills WHERE user_id = UPPER(:2))
                        AND ccycode = 'ETB'`,
                params: [count, userId, value]
            });
        }
    }

    // Update till totals
    const totalAmount = calculateDenominationTotal(denomination);
    updates.push({
        query: `UPDATE FCUBSPRD.fbtb_till_totals
                SET INFLOW = INFLOW + :1
                WHERE till_id = (SELECT TILL_ID FROM FCUBSPRD.smtb_user_tills WHERE user_id = UPPER(:2))
                AND ccycode = 'ETB' AND POSTINGDATE = TO_DATE(CURRENT_DATE)`,
        params: [totalAmount, userId]
    });

    try {
        // Execute all updates
        for (const { query, params } of updates) {
            const result = await executeQuery(query, params);
            if (!result.success) {
                console.error('Till update error:', result.error);
            }
        }
        return { success: true, message: 'Till updated successfully for deposit' };
    } catch (error) {
        console.error('Till update error:', error);
        return { success: false, error: error.message };
    }
}

/**
 * Update till denominations for withdraw (outflow)
 * This is the reverse of deposit - decreases till counts
 * @param {string} userId - The Flexcube user ID
 * @param {Object} denomination - Denomination breakdown
 */
export async function updateTillForWithdraw(userId, denomination) {
    if (!denomination) return { success: true, message: 'No denomination to update' };

    const updates = [];
    const denomMap = [
        { field: 'd200', value: 200 },
        { field: 'd100', value: 100 },
        { field: 'd50', value: 50 },
        { field: 'd10', value: 10 },
        { field: 'd5', value: 5 },
        { field: 'd1', value: 1 },
        { field: 'dc50', value: 0.5 },
        { field: 'dc25', value: 0.25 },
        { field: 'dc10', value: 0.1 },
        { field: 'dc5', value: 0.05 },
        { field: 'dc1', value: 0.01 },
    ];

    for (const { field, value } of denomMap) {
        const count = denomination[field] || 0;
        if (count > 0) {
            // Update DENOMCOUNT (decrease) and OUTFLOW (increase)
            updates.push({
                query: `UPDATE FCUBSPRD.fbtb_till_detail_ccy
                        SET DENOMCOUNT = DENOMCOUNT - :1, OUTFLOW = OUTFLOW + :1
                        WHERE denomcode = (
                            SELECT denomcode FROM FCUBSPRD.fbtb_till_detail_ccy
                            WHERE till_id = (SELECT TILL_ID FROM FCUBSPRD.smtb_user_tills WHERE user_id = UPPER(:2))
                            AND denomval = :3 AND ccycode = 'ETB'
                            ORDER BY denomcode ASC FETCH FIRST 1 ROWS ONLY
                        )
                        AND till_id = (SELECT TILL_ID FROM FCUBSPRD.smtb_user_tills WHERE user_id = UPPER(:2))
                        AND ccycode = 'ETB'`,
                params: [count, userId, value]
            });
        }
    }

    // Update till totals (outflow)
    const totalAmount = calculateDenominationTotal(denomination);
    updates.push({
        query: `UPDATE FCUBSPRD.fbtb_till_totals
                SET OUTFLOW = OUTFLOW + :1
                WHERE till_id = (SELECT TILL_ID FROM FCUBSPRD.smtb_user_tills WHERE user_id = UPPER(:2))
                AND ccycode = 'ETB' AND POSTINGDATE = TO_DATE(CURRENT_DATE)`,
        params: [totalAmount, userId]
    });

    try {
        // Execute all updates
        for (const { query, params } of updates) {
            const result = await executeQuery(query, params);
            if (!result.success) {
                console.error('Till update error:', result.error);
            }
        }
        return { success: true, message: 'Till updated successfully for withdraw' };
    } catch (error) {
        console.error('Till update error:', error);
        return { success: false, error: error.message };
    }
}

// ============================================
// XREF GENERATION
// ============================================

/**
 * Generate new 16-digit XREF
 */
export async function generateXref() {
    return await XrefCounter.getNextXref();
}

// ============================================
// MAIN TRANSACTION PROCESSING
// ============================================

/**
 * Process a complete withdraw transaction with all checks
 */
export async function processWithdrawTransaction(params) {
    const {
        transaction,        // The withdraw document
        user,              // The teller user
        denomination,      // Denomination breakdown
        skipLimitCheck = false
    } = params;

    const accountNumber = transaction.account_number;
    const amount = parseFloat(transaction.amount_in_figures);

    // 1. Validate denomination matches amount
    if (denomination) {
        const denomTotal = calculateDenominationTotal(denomination);
        if (Math.abs(denomTotal - amount) > 0.01) { // Allow 1 cent tolerance
            return {
                success: false,
                error: `Denomination total (ETB ${denomTotal.toFixed(2)}) does not match transaction amount (ETB ${amount.toFixed(2)})`
            };
        }
    }

    // 2. Check daily withdrawal limit (only for withdrawals)
    if (!skipLimitCheck) {
        const limitCheck = await checkWithdrawalLimit(accountNumber, amount);
        if (!limitCheck.allowed) {
            return {
                success: false,
                error: limitCheck.reason,
                limitDetails: limitCheck.details
            };
        }
    }

    // 3. Check maker-checker threshold
    const thresholdCheck = await checkMakerCheckerThreshold(amount);

    // 4. If amount is below threshold, process immediately
    if (!thresholdCheck.needsChecker) {
        // Generate XREF
        const xref = await generateXref();

        // Execute Flexcube transaction
        const flexResult = await createWithdrawTransaction({
            customerAccount: accountNumber,
            amount: amount,
            tellerBranch: user.branch || extractBranchFromAccount(accountNumber),
            denomination
        });

        if (!flexResult.success) {
            return {
                success: false,
                error: 'Flexcube transaction failed: ' + (flexResult.error || 'Unknown error'),
                flexcubeResponse: flexResult
            };
        }

        // Update till
        if (denomination && user.flex_id) {
            await updateTillForWithdraw(user.flex_id, denomination);
        }

        return {
            success: true,
            autoAuthorized: true,
            xref,
            trnRefNo: flexResult.trnRefNo,
            message: 'Transaction processed and auto-authorized',
            flexcubeResponse: flexResult,
            thresholdDetails: thresholdCheck
        };
    }

    // 5. Amount >= threshold, save as pending for checker
    const xref = await generateXref();

    return {
        success: true,
        autoAuthorized: false,
        needsChecker: true,
        xref,
        message: 'Transaction saved pending checker approval',
        thresholdDetails: thresholdCheck
    };
}

/**
 * Process checker approval for a pending transaction
 */
export async function processCheckerApproval(params) {
    const {
        transaction,
        checker,
        denomination,
        approved = true,
        remarks
    } = params;

    if (!approved) {
        return {
            success: true,
            approved: false,
            message: 'Transaction rejected by checker'
        };
    }

    const accountNumber = transaction.account_number;
    const amount = parseFloat(transaction.amount_in_figures);
    const transactionType = transaction.request_type?.toLowerCase();

    let flexResult;

    // Execute the appropriate transaction
    if (transactionType === 'withdraw') {
        flexResult = await createWithdrawTransaction({
            customerAccount: accountNumber,
            amount: amount,
            tellerBranch: checker.branch || extractBranchFromAccount(accountNumber),
            denomination
        });

        // Update till for withdraw
        if (flexResult.success && denomination && checker.flex_id) {
            await updateTillForWithdraw(checker.flex_id, denomination);
        }
    } else if (transactionType === 'deposit') {
        flexResult = await createDepositTransaction({
            customerAccount: accountNumber,
            amount: amount,
            tellerBranch: checker.branch || extractBranchFromAccount(accountNumber),
            denomination
        });

        // Update till for deposit
        if (flexResult.success && denomination && checker.flex_id) {
            await updateTillForDeposit(checker.flex_id, denomination);
        }
    } else if (transactionType === 'transfer') {
        flexResult = await createTransferTransaction({
            fromAccount: accountNumber,
            toAccount: transaction.beneficiary_account || transaction.transfer_to_account,
            amount: amount,
            tellerBranch: checker.branch
        });
        // No till update for transfers
    }

    if (!flexResult?.success) {
        return {
            success: false,
            error: 'Flexcube transaction failed: ' + (flexResult?.error || 'Unknown error'),
            flexcubeResponse: flexResult
        };
    }

    return {
        success: true,
        approved: true,
        trnRefNo: flexResult.trnRefNo,
        message: 'Transaction approved and processed by checker',
        flexcubeResponse: flexResult
    };
}

export default {
    extractCifFromAccount,
    extractBranchFromAccount,
    calculateDenominationTotal,
    autopopulateDenomination,
    getCustomerCategory,
    getDailyWithdrawalTotal,
    getCategoryDailyLimit,
    checkWithdrawalLimit,
    checkMakerCheckerThreshold,
    buildCreateTransactionSOAP,
    executeFlexcubeTransaction,
    createDepositTransaction,
    createWithdrawTransaction,
    createTransferTransaction,
    updateTillForDeposit,
    updateTillForWithdraw,
    generateXref,
    processWithdrawTransaction,
    processCheckerApproval
};
