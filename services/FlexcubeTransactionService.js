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
// DEBUG LOGGING UTILITY
// ============================================
const DEBUG = true; // Set to false to disable debug logging

function debugLog(section, message, data = null) {
    if (!DEBUG) return;
    const timestamp = new Date().toISOString();
    console.log('\n' + '='.repeat(60));
    console.log(`[${timestamp}] [FlexcubeService] [${section}]`);
    console.log('-'.repeat(60));
    console.log(message);
    if (data !== null) {
        console.log('-'.repeat(60));
        console.log('Data:', typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
    }
    console.log('='.repeat(60) + '\n');
}

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
    console.log("hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh", cif)
    const query = `SELECT CUSTOMER_CATEGORY FROM fcubsprd.sttm_customer WHERE CUSTOMER_NO = :1`;
    const result = await executeQuery(query, [cif]);

    console.log("hhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhhh777777777", result)

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

    console.log("llllllllllllllllllllllllllllllllllllllllllllllllllllllllll", categoryResult)
    if (!categoryResult.success) {
        console.warn('Could not fetch customer category - blocking for safety');
        return {
            allowed: false,
            reason: 'Customer verification failed - transaction blocked for safety',
            details: { cif },
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
            allowed: false,
            reason: 'Limit verification failed - transaction blocked for safety',
            details: { cif, category: customerCategory },
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
        console.warn('Could not fetch daily withdrawal total - blocking for safety');
        return {
            allowed: false,
            reason: 'Daily withdrawal check failed - transaction blocked for safety',
            details: { cif, category: customerCategory, dailyLimit },
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
 * Matches the format required by Oracle SOA FCUBSRTService
 * @param {Object} params Transaction parameters
 * @returns {string} SOAP XML message
 */
export function buildCreateTransactionSOAP(params) {
    const {
        product = 'SMRT',         // Product code (CSWL for withdrawal, CSDP for deposit, ETAL for transfer)
        branch,                    // Transaction branch
        txnBranch,                // Teller branch
        txnAccount,               // Transaction account (customer account)
        txnCurrency = 'ETB',
        txnAmount,
        offsetBranch,             // Offset branch (GL account branch)
        offsetAccount,            // Offset account (GL account or other customer account)
        offsetCurrency = 'ETB',
        offsetAmount,
        userId = 'SMARTB',       // Flexcube user ID - use SMART for external integration
        source = 'EXTIB',         // Source system - use EXTIB for external integration
        xref = '',                // External reference (16-digit)
        narrative = ''            // Transaction narrative/description
    } = params;

    // Prepend SMBR to XREF for Flexcube (Smart Branch identifier)
    const flexcubeXref = xref ? `SMBR${xref}` : `SMBR${Date.now()}`;

    // Generate MSGID from XREF (should be unique)
    const msgId = flexcubeXref;
    // CORRELID is typically first 18 characters of MSGID
    const correlId = msgId.length >= 18 ? msgId.substring(0, 18) : msgId.padEnd(18, '0');

    // Get current date in YYYY-MM-DD format for TXNDATE and VALDATE
    const today = new Date().toISOString().split('T')[0];

    // Build narrative - use provided or default to XREF in brackets
    const txnNarrative = narrative || `[${flexcubeXref}]`;

    debugLog('SOAP_BUILD', 'Building SOAP message (Flexcube SOA Format)', {
        product, branch, txnBranch, txnAccount, txnAmount,
        offsetBranch, offsetAccount, offsetAmount,
        userId, source, xref: flexcubeXref, msgId, correlId, txnDate: today
    });

    // IMPORTANT: Always use FTT for TXNTRN and OFFSETTRN as per Flexcube requirements
    // TXNBRN should be same as BRN (customer branch)
    const soapMessage = `<?xml version="1.0" encoding="UTF-8"?>
<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:fcub="http://fcubs.ofss.com/service/FCUBSRTService">
    <soapenv:Header/>
    <soapenv:Body>
        <fcub:CREATETRANSACTION_FSFS_REQ>
            <fcub:FCUBS_HEADER>
                <fcub:SOURCE>${source}</fcub:SOURCE>
                <fcub:UBSCOMP>FCUBS</fcub:UBSCOMP>
                <fcub:MSGID>${msgId}</fcub:MSGID>
                <fcub:CORRELID>${correlId}</fcub:CORRELID>
                <fcub:USERID>${userId}</fcub:USERID>
                <fcub:BRANCH>${branch}</fcub:BRANCH>
                <fcub:MODULEID>RT</fcub:MODULEID>
                <fcub:SERVICE>FCUBSRTService</fcub:SERVICE>
                <fcub:OPERATION>CreateTransaction</fcub:OPERATION>
                <fcub:MSGSTAT>SUCCESS</fcub:MSGSTAT>
            </fcub:FCUBS_HEADER>
            <fcub:FCUBS_BODY>
                <fcub:Transaction-Details>
                    <fcub:XREF>${flexcubeXref}</fcub:XREF>
                    <fcub:PRD>${product}</fcub:PRD>
                    <fcub:BRN>${branch}</fcub:BRN>
                    <fcub:TXNBRN>${txnBranch}</fcub:TXNBRN>
                    <fcub:TXNACC>${txnAccount}</fcub:TXNACC>
                    <fcub:TXNCCY>${txnCurrency}</fcub:TXNCCY>
                    <fcub:TXNAMT>${parseFloat(txnAmount).toFixed(2)}</fcub:TXNAMT>
                    <fcub:TXNTRN>FTT</fcub:TXNTRN>
                    <fcub:OFFSETBRN>${offsetBranch}</fcub:OFFSETBRN>
                    <fcub:OFFSETACC>${offsetAccount}</fcub:OFFSETACC>
                    <fcub:OFFSETCCY>${offsetCurrency}</fcub:OFFSETCCY>
                    <fcub:OFFSETAMT>${parseFloat(offsetAmount || txnAmount).toFixed(2)}</fcub:OFFSETAMT>
                    <fcub:OFFSETTRN>FTT</fcub:OFFSETTRN>
                    <fcub:TXNDATE>${today}</fcub:TXNDATE>
                    <fcub:VALDATE>${today}</fcub:VALDATE>
                    <fcub:NARRATIVE>${txnNarrative}</fcub:NARRATIVE>
                </fcub:Transaction-Details>
            </fcub:FCUBS_BODY>
        </fcub:CREATETRANSACTION_FSFS_REQ>
    </soapenv:Body>
</soapenv:Envelope>`;

    // NOTE: Charge-Details commented out for now
    // <fcub:Charge-Details>
    //     <fcub:CHGCOMP>CHME</fcub:CHGCOMP>
    //     <fcub:CHGAMT>0.00</fcub:CHGAMT>
    //     <fcub:CHGCCY>ETB</fcub:CHGCCY>
    // </fcub:Charge-Details>

    return soapMessage;
}

/**
 * Execute SOAP transaction to Flexcube
 * Note: This requires actual SOAP client implementation
 */
export async function executeFlexcubeTransaction(soapMessage, endpoint = null) {
    // Endpoint configured via FLEXCUBE_RT_SERVICE_URL in .env
    const flexcubeEndpoint = endpoint || process.env.FLEXCUBE_RT_SERVICE_URL;
    if (!flexcubeEndpoint) {
        throw new Error('FLEXCUBE_RT_SERVICE_URL is not configured in .env');
    }

    // Timeout in milliseconds (30 seconds)
    const TIMEOUT_MS = 30000;

    debugLog('SOAP_EXECUTE_START', 'Starting SOAP transaction', {
        endpoint: flexcubeEndpoint,
        messageLength: soapMessage.length,
        timeout: TIMEOUT_MS
    });

    // Log the SOAP request (truncated for readability)
    console.log('\n' + '='.repeat(80));
    console.log('[SOAP REQUEST]');
    console.log('Endpoint:', flexcubeEndpoint);
    console.log('-'.repeat(80));
    console.log('Request Body:');
    console.log(soapMessage);
    console.log('='.repeat(80) + '\n');

    try {
        const startTime = Date.now();

        // Create AbortController for timeout
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS);

        const response = await fetch(flexcubeEndpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'text/xml;charset=UTF-8',
                'SOAPAction': '"CreateTransaction"'
            },
            body: soapMessage,
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        const responseText = await response.text();
        const duration = Date.now() - startTime;

        console.log('\n' + '='.repeat(80));
        console.log('[SOAP RESPONSE]');
        console.log('Status:', response.status, response.statusText);
        console.log('Duration:', duration, 'ms');
        console.log('-'.repeat(80));
        console.log('Response Body:');
        console.log(responseText);
        console.log('='.repeat(80) + '\n');

        // Parse response to check for success/failure
        const isSuccess = responseText.includes('<ns0:MSGSTAT>SUCCESS</ns0:MSGSTAT>') ||
                          responseText.includes('MSGSTAT>SUCCESS<') ||
                          responseText.includes('<MSGSTAT>SUCCESS</MSGSTAT>');

        // Extract transaction reference if available
        let trnRefNo = null;
        const trnRefMatch = responseText.match(/<(?:ns0:)?FCCREF>([^<]+)<\/(?:ns0:)?FCCREF>/) ||
                           responseText.match(/<(?:ns0:)?TRN_REF_NO>([^<]+)<\/(?:ns0:)?TRN_REF_NO>/) ||
                           responseText.match(/<(?:ns0:)?XREF>([^<]+)<\/(?:ns0:)?XREF>/);
        if (trnRefMatch) {
            trnRefNo = trnRefMatch[1];
        }

        // Extract error message if failed
        let errorMessage = null;
        if (!isSuccess) {
            const errorMatch = responseText.match(/<(?:ns0:)?EDESC>([^<]+)<\/(?:ns0:)?EDESC>/) ||
                              responseText.match(/<(?:ns0:)?ERROR_DESC>([^<]+)<\/(?:ns0:)?ERROR_DESC>/) ||
                              responseText.match(/<faultstring>([^<]+)<\/faultstring>/);
            if (errorMatch) {
                errorMessage = errorMatch[1];
            }
        }

        const result = {
            success: isSuccess,
            trnRefNo,
            rawResponse: responseText,
            httpStatus: response.status,
            duration,
            error: isSuccess ? null : (errorMessage || 'Transaction failed - check rawResponse for details')
        };

        debugLog('SOAP_EXECUTE_COMPLETE', `SOAP transaction ${isSuccess ? 'SUCCESS' : 'FAILED'}`, result);

        return result;
    } catch (error) {
        // Extract detailed error information
        let errorDetails = error.message;
        let errorCode = 'UNKNOWN';

        // Check for specific error types
        if (error.name === 'AbortError') {
            errorDetails = `Connection timeout after ${TIMEOUT_MS}ms - Flexcube server not responding`;
            errorCode = 'TIMEOUT';
        } else if (error.cause) {
            // Node.js fetch wraps the actual error in 'cause'
            const cause = error.cause;
            errorCode = cause.code || cause.errno || 'NETWORK_ERROR';

            if (cause.code === 'ECONNREFUSED') {
                errorDetails = `Connection refused - Flexcube server at ${flexcubeEndpoint} is not accepting connections. Check if the server is running and the port is correct.`;
            } else if (cause.code === 'ENOTFOUND') {
                errorDetails = `DNS lookup failed - Cannot resolve hostname. Check if the endpoint URL is correct: ${flexcubeEndpoint}`;
            } else if (cause.code === 'ETIMEDOUT') {
                errorDetails = `Connection timed out - Cannot reach Flexcube server at ${flexcubeEndpoint}. Check network connectivity and firewall rules.`;
            } else if (cause.code === 'ECONNRESET') {
                errorDetails = `Connection reset by Flexcube server. The server closed the connection unexpectedly.`;
            } else if (cause.code === 'EHOSTUNREACH') {
                errorDetails = `Host unreachable - Cannot reach ${flexcubeEndpoint}. Check network routing and firewall.`;
            } else {
                errorDetails = `Network error: ${cause.message || cause.code || error.message}`;
            }
        }

        console.error('\n' + '='.repeat(80));
        console.error('[SOAP ERROR]');
        console.error('Error Code:', errorCode);
        console.error('Error Details:', errorDetails);
        console.error('Original Error:', error.message);
        if (error.cause) {
            console.error('Cause:', JSON.stringify({
                code: error.cause.code,
                errno: error.cause.errno,
                syscall: error.cause.syscall,
                address: error.cause.address,
                port: error.cause.port,
                message: error.cause.message
            }, null, 2));
        }
        console.error('Stack:', error.stack);
        console.error('='.repeat(80));
        console.error('\n[TROUBLESHOOTING]');
        console.error('1. Verify Flexcube server is running at:', flexcubeEndpoint);
        console.error('2. Check if you can ping the IP: ping 10.1.245.18');
        console.error('3. Check if port 7003 is open: telnet 10.1.245.18 7003');
        console.error('4. Verify firewall rules allow outbound connections to this endpoint');
        console.error('5. If using VPN, ensure VPN is connected');
        console.error('='.repeat(80) + '\n');

        debugLog('SOAP_EXECUTE_ERROR', 'SOAP transaction exception', {
            error: errorDetails,
            errorCode,
            originalError: error.message
        });

        return {
            success: false,
            error: errorDetails,
            errorCode,
            rawResponse: null
        };
    }
}

/**
 * Create Deposit transaction (Credit customer account, Debit GL)
 * For deposit: GL is debited (cash received), Customer account is credited
 */
export async function createDepositTransaction(params) {
    const {
        customerAccount,
        amount,
        tellerBranch,
        glAccount = '101101', // Default GL account for cash
        xref,
        narrative = ''
    } = params;

    const customerBranch = extractBranchFromAccount(customerAccount);

    debugLog('DEPOSIT_TXN_START', 'Creating Deposit SOAP Transaction', {
        customerAccount,
        amount,
        tellerBranch,
        customerBranch,
        glAccount,
        xref
    });

    const soapParams = {
        product: 'SMCA',              // Cash Deposit product
        branch: tellerBranch,
        txnBranch: tellerBranch || customerBranch,
        txnAccount: glAccount,        // Debit GL account (cash in)
        txnCurrency: 'ETB',
        txnAmount: amount,
        offsetBranch: customerBranch,
        offsetAccount: customerAccount, // Credit customer account
        offsetCurrency: 'ETB',
        offsetAmount: amount,
        userId: 'SMARTB',            // External integration user
        source: 'EXTIB',              // External integration source
        xref: xref,
        narrative: narrative || `DEPOSIT-${customerAccount}`
    };

    debugLog('DEPOSIT_TXN_PARAMS', 'SOAP Parameters', soapParams);

    const soapMessage = buildCreateTransactionSOAP(soapParams);
    const result = await executeFlexcubeTransaction(soapMessage);

    debugLog('DEPOSIT_TXN_RESULT', 'Deposit Transaction Result', {
        success: result.success,
        trnRefNo: result.trnRefNo,
        error: result.error
    });

    return result;
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
        glAccount = '101101', // Default GL account for cash
        xref,
        narrative = ''
    } = params;

    const customerBranch = extractBranchFromAccount(customerAccount);

    debugLog('WITHDRAW_TXN_START', 'Creating Withdraw SOAP Transaction', {
        customerAccount,
        amount,
        tellerBranch,
        customerBranch,
        glAccount,
        xref
    });

    const soapParams = {
        product: 'SMCA',              // Cash Withdrawal product
        branch: tellerBranch,
        txnBranch: customerBranch,
        txnAccount: customerAccount,  // Debit customer account
        txnCurrency: 'ETB',
        txnAmount: amount,
        offsetBranch: tellerBranch || customerBranch,
        offsetAccount: glAccount,     // Credit GL account (teller's till)
        offsetCurrency: 'ETB',
        offsetAmount: amount,
        userId: 'SMARTB',            // External integration user
        source: 'EXTIB',              // External integration source
        xref: xref,
        narrative: narrative || `WITHDRAW-${customerAccount}`
    };

    debugLog('WITHDRAW_TXN_PARAMS', 'SOAP Parameters', soapParams);

    const soapMessage = buildCreateTransactionSOAP(soapParams);
    const result = await executeFlexcubeTransaction(soapMessage);

    debugLog('WITHDRAW_TXN_RESULT', 'Withdraw Transaction Result', {
        success: result.success,
        trnRefNo: result.trnRefNo,
        error: result.error
    });

    return result;
}

/**
 * Create Transfer transaction (Debit customer account, Credit beneficiary account)
 * No till update needed for transfers (no cash involved)
 * No limit check needed (transfer between accounts)
 * No denomination needed (no cash involved)
 */
export async function createTransferTransaction(params) {
    const {
        fromAccount,
        toAccount,
        amount,
        tellerBranch,
        xref,
        narrative = ''
    } = params;

    const fromBranch = extractBranchFromAccount(fromAccount);
    const toBranch = extractBranchFromAccount(toAccount);

    debugLog('TRANSFER_TXN_START', 'Creating Transfer SOAP Transaction', {
        fromAccount,
        toAccount,
        amount,
        tellerBranch,
        fromBranch,
        toBranch,
        xref
    });

    const soapParams = {
        product: 'SMRT',              // Electronic Transfer product
        branch: tellerBranch,
        txnBranch: fromBranch || fromBranch,
        txnAccount: fromAccount,      // Debit source account
        txnCurrency: 'ETB',
        txnAmount: amount,
        offsetBranch: toBranch,
        offsetAccount: toAccount,     // Credit destination account
        offsetCurrency: 'ETB',
        offsetAmount: amount,
        userId: 'SMARTB',            // External integration user
        source: 'EXTIB',              // External integration source
        xref: xref,
        narrative: narrative || `TRANSFER-${fromAccount}-TO-${toAccount}`
    };

    debugLog('TRANSFER_TXN_PARAMS', 'SOAP Parameters', soapParams);

    const soapMessage = buildCreateTransactionSOAP(soapParams);
    const result = await executeFlexcubeTransaction(soapMessage);

    debugLog('TRANSFER_TXN_RESULT', 'Transfer Transaction Result', {
        success: result.success,
        trnRefNo: result.trnRefNo,
        error: result.error
    });

    return result;
}

// ============================================
// TILL UPDATE FUNCTIONS
// ============================================

/**
 * Update till denominations for deposit (inflow)
 * Table: FBTB_TILL_DETAIL_CCY
 * Columns: TILL_ID, CCYCODE, DENOMCODE, DENOMTXT, DENOMVAL, DENOMCOUNT, BRANCHCODE, OPENINGBALANCE, INFLOW, OUTFLOW
 * DENOMCOUNT = OPENINGBALANCE + INFLOW - OUTFLOW (calculated, no need to update directly)
 * For deposit: INFLOW = INFLOW + count
 *
 * @param {string} tillId - The till ID from User model (e.g., 'SARIS_TILL3')
 * @param {string} branchCode - The branch code from User model (e.g., '159')
 * @param {Object} denomination - Denomination breakdown
 */
export async function updateTillForDeposit(tillId, branchCode, denomination) {
    debugLog('TILL_DEPOSIT_START', 'Starting till update for DEPOSIT', { tillId, branchCode, denomination });

    if (!tillId || !branchCode) {
        debugLog('TILL_DEPOSIT_ERROR', 'Missing tillId or branchCode', { tillId, branchCode });
        return { success: false, error: 'Missing tillId or branchCode for till update' };
    }

    if (!denomination) {
        debugLog('TILL_DEPOSIT', 'No denomination provided, skipping update');
        return { success: true, message: 'No denomination to update' };
    }

    // DIAGNOSTIC: First query to see what data exists in the till
    debugLog('TILL_DEPOSIT_DIAGNOSTIC', 'Querying existing till data to diagnose...');
    try {
        const diagnosticQuery = `
            SELECT TILL_ID, BRANCHCODE, DENOMVAL, DENOMTXT, CCYCODE, INFLOW, OUTFLOW, OPENINGBALANCE
            FROM FCUBSPRD.FBTB_TILL_DETAIL_CCY
            WHERE TILL_ID = :1
            AND BRANCHCODE = :2
            AND CCYCODE = 'ETB'
            ORDER BY DENOMVAL DESC
        `;
        const diagnosticResult = await executeQuery(diagnosticQuery, [tillId, branchCode]);

        if (diagnosticResult.success && diagnosticResult.data) {
            debugLog('TILL_DEPOSIT_DIAGNOSTIC_RESULT', `Found ${diagnosticResult.data.length} rows in till`, {
                tillId,
                branchCode,
                rowCount: diagnosticResult.data.length,
                sampleData: diagnosticResult.data.slice(0, 3)
            });

            const denomVals = diagnosticResult.data.map(row => ({
                DENOMVAL: row.DENOMVAL,
                DENOMVAL_TYPE: typeof row.DENOMVAL,
                DENOMTXT: row.DENOMTXT
            }));
            debugLog('TILL_DEPOSIT_DENOMVALS', 'Denomination values in table', denomVals);
        } else {
            debugLog('TILL_DEPOSIT_DIAGNOSTIC_EMPTY', 'No data found for this till/branch combination', {
                tillId,
                branchCode,
                error: diagnosticResult.error
            });

            const branchTillsQuery = `
                SELECT DISTINCT TILL_ID, BRANCHCODE
                FROM FCUBSPRD.FBTB_TILL_DETAIL_CCY
                WHERE BRANCHCODE = :1 AND CCYCODE = 'ETB'
            `;
            const branchTillsResult = await executeQuery(branchTillsQuery, [branchCode]);
            if (branchTillsResult.success && branchTillsResult.data) {
                debugLog('TILL_DEPOSIT_AVAILABLE_TILLS', `Tills available for branch ${branchCode}`, branchTillsResult.data);
            }
        }
    } catch (diagError) {
        debugLog('TILL_DEPOSIT_DIAGNOSTIC_ERROR', 'Diagnostic query failed', { error: diagError.message });
    }

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

    let totalDepositAmount = 0; // Will hold sum of count * value for all denominations

    for (const { field, value } of denomMap) {
        const count = denomination[field] || 0;
        if (count > 0) {
            const amount = count * value;
            totalDepositAmount += amount;
            debugLog('TILL_DEPOSIT_DENOM', `Adding denomination update: ${field} = ${count} x ${value} (amount: ${amount})`, { field, count, value, amount });
            // Update INFLOW for the specific denomination
            updates.push({
                query: `UPDATE FCUBSPRD.FBTB_TILL_DETAIL_CCY
                        SET INFLOW = INFLOW + :1,
                            DENOMCOUNT = OPENINGBALANCE + (INFLOW + :2) - OUTFLOW
                        WHERE TILL_ID = :3
                        AND BRANCHCODE = :4
                        AND DENOMVAL = :5
                        AND CCYCODE = 'ETB'`,
                params: [count, count, tillId, branchCode, value],
                description: `Deposit denom update: ${field} (${value} ETB) x ${count}`
            });
        }
    }

    // --- ADDED: Update totals table for the entire deposit ---
    if (totalDepositAmount > 0) {
        debugLog('TILL_DEPOSIT_TOTALS', 'Adding totals update', { tillId, totalDepositAmount });
        updates.push({
            query: `UPDATE FCUBSPRD.fbtb_till_totals
                    SET inflow = inflow + :1
                    WHERE till_id = :2
                      AND ccycode = 'ETB'
                      AND branchcode = :3
                      AND POSTINGDATE = TO_DATE(CURRENT_DATE)`,
            params: [totalDepositAmount, tillId, branchCode],
            description: `Deposit total inflow update: ${totalDepositAmount} ETB`
        });
    }
    // --- END ADDED ---

    debugLog('TILL_DEPOSIT_QUERIES', `Total queries to execute: ${updates.length}`);

    try {
        let successCount = 0;
        let failCount = 0;
        let totalRowsAffected = 0;

        for (let i = 0; i < updates.length; i++) {
            const { query, params, description } = updates[i];
            debugLog('TILL_DEPOSIT_EXEC', `Executing query ${i + 1}/${updates.length}: ${description}`, { query, params });

            const result = await executeQuery(query, params);

            if (result.success) {
                successCount++;
                const rowsAffected = result.rowsAffected || 0;
                totalRowsAffected += rowsAffected;
                debugLog('TILL_DEPOSIT_RESULT', `Query ${i + 1} SUCCESS`, { rowsAffected });

                if (rowsAffected === 0) {
                    debugLog('TILL_DEPOSIT_WARNING', `Query ${i + 1} affected 0 rows`, { params });
                }
            } else {
                failCount++;
                debugLog('TILL_DEPOSIT_ERROR', `Query ${i + 1} FAILED`, { error: result.error });
            }
        }

        const finalResult = {
            success: failCount === 0,
            message: `Till updated for deposit: ${successCount} success, ${failCount} failed, ${totalRowsAffected} rows affected`,
            successCount,
            failCount,
            totalRowsAffected,
            tillId,
            branchCode
        };
        debugLog('TILL_DEPOSIT_COMPLETE', 'Till deposit update completed', finalResult);
        return finalResult;
    } catch (error) {
        debugLog('TILL_DEPOSIT_EXCEPTION', 'Exception during till deposit update', { error: error.message, stack: error.stack });
        return { success: false, error: error.message };
    }
}

/**
 * Update till denominations for withdraw (outflow)
 * Table: FBTB_TILL_DETAIL_CCY
 * Columns: TILL_ID, CCYCODE, DENOMCODE, DENOMTXT, DENOMVAL, DENOMCOUNT, BRANCHCODE, OPENINGBALANCE, INFLOW, OUTFLOW
 * DENOMCOUNT = OPENINGBALANCE + INFLOW - OUTFLOW (calculated, no need to update directly)
 * For withdraw: OUTFLOW = OUTFLOW + count
 *
 * @param {string} tillId - The till ID from User model (e.g., 'SARIS_TILL3')
 * @param {string} branchCode - The branch code from User model (e.g., '159')
 * @param {Object} denomination - Denomination breakdown
 */
export async function updateTillForWithdraw(tillId, branchCode, denomination) {
    debugLog('TILL_WITHDRAW_START', 'Starting till update for WITHDRAW', { tillId, branchCode, denomination });

    if (!tillId || !branchCode) {
        debugLog('TILL_WITHDRAW_ERROR', 'Missing tillId or branchCode', { tillId, branchCode });
        return { success: false, error: 'Missing tillId or branchCode for till update' };
    }

    if (!denomination) {
        debugLog('TILL_WITHDRAW', 'No denomination provided, skipping update');
        return { success: true, message: 'No denomination to update' };
    }

    // DIAGNOSTIC: First query to see what data exists in the till
    debugLog('TILL_WITHDRAW_DIAGNOSTIC', 'Querying existing till data to diagnose...');
    try {
        const diagnosticQuery = `
            SELECT TILL_ID, BRANCHCODE, DENOMVAL, DENOMTXT, CCYCODE, INFLOW, OUTFLOW, OPENINGBALANCE
            FROM FCUBSPRD.FBTB_TILL_DETAIL_CCY
            WHERE TILL_ID = :1
            AND BRANCHCODE = :2
            AND CCYCODE = 'ETB'
            ORDER BY DENOMVAL DESC
        `;
        const diagnosticResult = await executeQuery(diagnosticQuery, [tillId, branchCode]);

        if (diagnosticResult.success && diagnosticResult.data) {
            debugLog('TILL_WITHDRAW_DIAGNOSTIC_RESULT', `Found ${diagnosticResult.data.length} rows in till`, {
                tillId,
                branchCode,
                rowCount: diagnosticResult.data.length,
                sampleData: diagnosticResult.data.slice(0, 3)
            });

            const denomVals = diagnosticResult.data.map(row => ({
                DENOMVAL: row.DENOMVAL,
                DENOMVAL_TYPE: typeof row.DENOMVAL,
                DENOMTXT: row.DENOMTXT
            }));
            debugLog('TILL_WITHDRAW_DENOMVALS', 'Denomination values in table', denomVals);
        } else {
            debugLog('TILL_WITHDRAW_DIAGNOSTIC_EMPTY', 'No data found for this till/branch combination', {
                tillId,
                branchCode,
                error: diagnosticResult.error
            });

            const branchTillsQuery = `
                SELECT DISTINCT TILL_ID, BRANCHCODE
                FROM FCUBSPRD.FBTB_TILL_DETAIL_CCY
                WHERE BRANCHCODE = :1 AND CCYCODE = 'ETB'
            `;
            const branchTillsResult = await executeQuery(branchTillsQuery, [branchCode]);
            if (branchTillsResult.success && branchTillsResult.data) {
                debugLog('TILL_WITHDRAW_AVAILABLE_TILLS', `Tills available for branch ${branchCode}`, branchTillsResult.data);
            }
        }
    } catch (diagError) {
        debugLog('TILL_WITHDRAW_DIAGNOSTIC_ERROR', 'Diagnostic query failed', { error: diagError.message });
    }

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

    let totalWithdrawAmount = 0; // Will hold sum of count * value for all denominations

    for (const { field, value } of denomMap) {
        const count = denomination[field] || 0;
        if (count > 0) {
            const amount = count * value;
            totalWithdrawAmount += amount;
            debugLog('TILL_WITHDRAW_DENOM', `Adding denomination update: ${field} = ${count} x ${value} (amount: ${amount})`, { field, count, value, amount });
            // Update OUTFLOW and DENOMCOUNT for the specific denomination
            updates.push({
                query: `UPDATE FCUBSPRD.FBTB_TILL_DETAIL_CCY
                        SET OUTFLOW = OUTFLOW + :1,
                            DENOMCOUNT = OPENINGBALANCE + INFLOW - (OUTFLOW + :2)
                        WHERE TILL_ID = :3
                        AND BRANCHCODE = :4
                        AND DENOMVAL = :5
                        AND CCYCODE = 'ETB'`,
                params: [count, count, tillId, branchCode, value],
                description: `Withdraw denom update: ${field} (${value} ETB) x ${count}`
            });
        }
    }

    // --- ADDED: Update totals table to subtract the withdrawal amount ---
    if (totalWithdrawAmount > 0) {
        debugLog('TILL_WITHDRAW_TOTALS', 'Adding totals update (subtract)', { tillId, totalWithdrawAmount });
        updates.push({
            query: `UPDATE FCUBSPRD.fbtb_till_totals
                    SET outflow = outflow + :1
                    WHERE till_id = :2
                      AND ccycode = 'ETB'
                      AND branchcode = :3
                      AND POSTINGDATE = TO_DATE(CURRENT_DATE)`,
            params: [totalWithdrawAmount, tillId, branchCode],
            description: `Withdraw total outflow reduction: ${totalWithdrawAmount} ETB`
        });
    }
    // --- END ADDED ---

    debugLog('TILL_WITHDRAW_QUERIES', `Total queries to execute: ${updates.length}`);

    try {
        let successCount = 0;
        let failCount = 0;
        let totalRowsAffected = 0;

        for (let i = 0; i < updates.length; i++) {
            const { query, params, description } = updates[i];
            debugLog('TILL_WITHDRAW_EXEC', `Executing query ${i + 1}/${updates.length}: ${description}`, { query, params });

            const result = await executeQuery(query, params);

            if (result.success) {
                successCount++;
                const rowsAffected = result.rowsAffected || 0;
                totalRowsAffected += rowsAffected;
                debugLog('TILL_WITHDRAW_RESULT', `Query ${i + 1} SUCCESS`, { rowsAffected });

                if (rowsAffected === 0) {
                    debugLog('TILL_WITHDRAW_WARNING', `Query ${i + 1} affected 0 rows`, { params });
                }
            } else {
                failCount++;
                debugLog('TILL_WITHDRAW_ERROR', `Query ${i + 1} FAILED`, { error: result.error });
            }
        }

        const finalResult = {
            success: failCount === 0,
            message: `Till updated for withdraw: ${successCount} success, ${failCount} failed, ${totalRowsAffected} rows affected`,
            successCount,
            failCount,
            totalRowsAffected,
            tillId,
            branchCode
        };
        debugLog('TILL_WITHDRAW_COMPLETE', 'Till withdraw update completed', finalResult);
        return finalResult;
    } catch (error) {
        debugLog('TILL_WITHDRAW_EXCEPTION', 'Exception during till withdraw update', { error: error.message, stack: error.stack });
        return { success: false, error: error.message };
    }
}
// ============================================
// TILL QUERY FUNCTIONS
// ============================================

/**
 * Get available denomination counts from a till
 * Table: FBTB_TILL_DETAIL_CCY
 * DENOMCOUNT = OPENINGBALANCE + INFLOW - OUTFLOW (calculated in Oracle, not stored)
 *
 * @param {string} tillId - The till ID from User model (e.g., 'SARIS_TILL3')
 * @param {string} branchCode - The branch code from User model (e.g., '159')
 * @returns {Object} Available denomination counts
 */
export async function getTillDenominations(tillId, branchCode) {
    debugLog('GET_TILL_DENOMS', 'Fetching till denominations', { tillId, branchCode });

    if (!tillId || !branchCode) {
        return { success: false, error: 'Missing tillId or branchCode' };
    }

    try {
        const query = `
            SELECT
                DENOMVAL,
                DENOMTXT,
                DENOMCOUNT,
                OPENINGBALANCE,
                INFLOW,
                OUTFLOW,
                (OPENINGBALANCE + INFLOW - OUTFLOW) AS AVAILABLE_COUNT
            FROM FCUBSPRD.FBTB_TILL_DETAIL_CCY
            WHERE TILL_ID = :1
            AND BRANCHCODE = :2
            AND CCYCODE = 'ETB'
            ORDER BY DENOMVAL DESC
        `;

        const result = await executeQuery(query, [tillId, branchCode]);

        if (!result.success) {
            debugLog('GET_TILL_DENOMS_ERROR', 'Query failed', { error: result.error });
            return { success: false, error: result.error };
        }

        // Map the results to a more usable format
        const denominations = {};
        const denomDetails = [];

        const denomMap = {
            200: 'd200',
            100: 'd100',
            50: 'd50',
            10: 'd10',
            5: 'd5',
            1: 'd1',
            0.5: 'dc50',
            0.25: 'dc25',
            0.1: 'dc10',
            0.05: 'dc5',
            0.01: 'dc1'
        };

        for (const row of result.data || []) {
            const denomVal = parseFloat(row.DENOMVAL);
            const availableCount = row.AVAILABLE_COUNT || (row.OPENINGBALANCE + row.INFLOW - row.OUTFLOW) || 0;

            // Map to our denomination keys
            const key = denomMap[denomVal];
            if (key) {
                denominations[key] = availableCount;
            }

            denomDetails.push({
                value: denomVal,
                text: row.DENOMTXT,
                available: availableCount,
                openingBalance: row.OPENINGBALANCE || 0,
                inflow: row.INFLOW || 0,
                outflow: row.OUTFLOW || 0
            });
        }

        debugLog('GET_TILL_DENOMS_SUCCESS', 'Till denominations fetched', { denominations, denomDetails });

        return {
            success: true,
            tillId,
            branchCode,
            denominations,
            details: denomDetails
        };
    } catch (error) {
        debugLog('GET_TILL_DENOMS_EXCEPTION', 'Exception fetching till denoms', { error: error.message });
        return { success: false, error: error.message };
    }
}

/**
 * Auto-populate denomination based on amount and available till counts
 * Uses greedy algorithm but respects available counts in till
 *
 * @param {number} amount - The amount to break down
 * @param {string} tillId - The till ID from User model
 * @param {string} branchCode - The branch code from User model
 * @returns {Object} Denomination breakdown
 */
export async function autopopulateDenominationWithTillCheck(amount, tillId, branchCode) {
    debugLog('AUTOPOPULATE_WITH_TILL', 'Auto-populating with till check', { amount, tillId, branchCode });

    // Get current till denominations
    const tillResult = await getTillDenominations(tillId, branchCode);

    if (!tillResult.success) {
        debugLog('AUTOPOPULATE_WITH_TILL', 'Could not fetch till, using basic autopopulate');
        // Fall back to basic autopopulate without till check
        return {
            success: true,
            denomination: autopopulateDenomination(amount),
            tillAvailable: null,
            warning: 'Could not verify till availability'
        };
    }

    const available = tillResult.denominations;
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
    const insufficientDenoms = [];

    for (const { key, value } of denominations) {
        if (remaining >= value) {
            // Calculate how many we need
            const needed = Math.floor(remaining / value);
            // Check how many are available
            const availableCount = available[key] || 0;
            // Use the minimum of needed and available
            const toUse = Math.min(needed, availableCount);

            result[key] = toUse;
            remaining = Math.round((remaining - toUse * value) * 100) / 100;

            if (toUse < needed) {
                insufficientDenoms.push({
                    denomination: value,
                    needed: needed,
                    available: availableCount,
                    used: toUse
                });
            }
        } else {
            result[key] = 0;
        }
    }

    const canFulfill = remaining < 0.01; // Allow for floating point errors

    debugLog('AUTOPOPULATE_WITH_TILL_RESULT', 'Auto-populate result', {
        denomination: result,
        remaining,
        canFulfill,
        insufficientDenoms
    });

    return {
        success: true,
        denomination: result,
        tillAvailable: available,
        canFulfill,
        remaining: remaining > 0.01 ? remaining : 0,
        insufficientDenoms: insufficientDenoms.length > 0 ? insufficientDenoms : null,
        warning: !canFulfill ? `Insufficient till balance. Cannot fulfill ${remaining.toFixed(2)} ETB` : null
    };
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

        // Update till using user's till_id and branch from User model
        if (denomination && user.till_id && user.branch) {
            await updateTillForWithdraw(user.till_id, user.branch, denomination);
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

        // Update till for withdraw using checker's till_id and branch
        if (flexResult.success && denomination && checker.till_id && checker.branch) {
            await updateTillForWithdraw(checker.till_id, checker.branch, denomination);
        }
    } else if (transactionType === 'deposit') {
        flexResult = await createDepositTransaction({
            customerAccount: accountNumber,
            amount: amount,
            tellerBranch: checker.branch || extractBranchFromAccount(accountNumber),
            denomination
        });

        // Update till for deposit using checker's till_id and branch
        if (flexResult.success && denomination && checker.till_id && checker.branch) {
            await updateTillForDeposit(checker.till_id, checker.branch, denomination);
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
    getTillDenominations,
    autopopulateDenominationWithTillCheck,
    generateXref,
    processWithdrawTransaction,
    processCheckerApproval
};
