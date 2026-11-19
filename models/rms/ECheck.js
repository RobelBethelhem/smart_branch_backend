import mongoose from "mongoose";
import requestExpiryFields from './requestExpiryFields.js';
import ECheckCounter from './ECheckCounter.js';
import XrefCounter from './XrefCounter.js';
const Schema = mongoose.Schema;

/**
 * Denomination Schema - Embedded schema for cash denominations
 * Ethiopian Birr denominations: 200, 100, 50, 10, 5, 1 (notes)
 * Coins: 0.50 (50 cent), 0.25 (25 cent), 0.10 (10 cent), 0.05 (5 cent), 0.01 (1 cent)
 */
const denominationSchema = new Schema({
    d200: { type: Number, default: 0 },      // 200 Birr notes
    d100: { type: Number, default: 0 },      // 100 Birr notes
    d50: { type: Number, default: 0 },       // 50 Birr notes
    d10: { type: Number, default: 0 },       // 10 Birr notes
    d5: { type: Number, default: 0 },        // 5 Birr notes
    d1: { type: Number, default: 0 },        // 1 Birr notes
    dc50: { type: Number, default: 0 },      // 50 cent coins
    dc25: { type: Number, default: 0 },      // 25 cent coins
    dc10: { type: Number, default: 0 },      // 10 cent coins
    dc5: { type: Number, default: 0 },       // 5 cent coins
    dc1: { type: Number, default: 0 },       // 1 cent coins
}, { _id: false });

const eCheckSchema = new Schema({
    branch: {
        type: String,
        trim: true,
    },
    acc_holder_name: {
        type: String,
        required: true,
        trim: true,
    },

    // NEW: Recipient information (cash recipient)
    recipient_full_name: {
        type: String,
        required: true,
        trim: true,
    },
    recipient_phone_number: {
        type: String,
        required: true,
        trim: true,
    },

    reassigned_by: {
        type: String,
        trim: true
    },

    reassigned_Date: {
        type: Date,
    },

    amount_in_words: {
        type: String,
        required: true,
        trim: true,
    },
    amount_in_figures: {
        type: String,
        required: true,
        trim: true,
    },
    signature: {
        type: String,
        required: true,
        trim: true,
    },
    account_number: {
        type: String,
        required: true,
        trim: true,
    },
    account_type: {
        type: String,
        required: true,
        enum: ['Saving Account', 'Demand/ Current Deposit Account', 'Special Demand Deposit Account'],
        default: 'Saving Account',
    },
    status: {
        type: String,
        required: true,
        enum: [
            'requested',
            'assigned_by_csr',
            'assigned',
            'pending_checker',   // Waiting for checker approval (amount >= threshold)
            'posted',
            'authorized',
            'audited',
            'delayed',
            'rejected',           // Rejected due to limit exceeded or other reasons
            'expired'            // Not completed on the day it was made (utils/rms/requestExpiry.js)
        ],
        default: 'requested',
        trim: true,
    },

    trn_ref_no: {
        type: String,
        trim: true,
    },

    // External Reference (16-digit auto-increment)
    xref: {
        type: String,
        trim: true,
        unique: true,
        sparse: true,
    },

    Queue_number: {
        type: String,
        required: false,
        trim: true,
    },
    Customer_Unique_Number: {
        type: String,
        required: true,
        unique: true,
        trim: true,
    },

    // Customer CIF (7 digits extracted from account number)
    customer_cif: {
        type: String,
        trim: true,
    },

    // Customer category from Flexcube
    customer_category: {
        type: String,
        trim: true,
    },

    // Denomination breakdown for cash withdrawal
    denomination: denominationSchema,

    // Calculated total from denomination
    denomination_total: {
        type: Number,
        default: 0,
    },

    // Daily limit check fields
    daily_limit: {
        type: Number,
        default: 0,
    },
    daily_withdrawn_before: {
        type: Number,
        default: 0,
    },
    limit_check_passed: {
        type: Boolean,
        default: false,
    },

    // Maker-checker fields
    needs_checker: {
        type: Boolean,
        default: false,
    },
    checker_threshold: {
        type: Number,
        default: 0,
    },

    // Maker (Initiator) information - the teller who initiated the transaction
    maker_name: {
        type: String,
        trim: true,
    },
    maker_id: {
        type: String,
        trim: true,
    },
    maker_date: {
        type: Date,
    },
    maker_remarks: {
        type: String,
        trim: true,
    },

    // Checker (Authorizer) information - the authorizer who approved the transaction
    checker_name: {
        type: String,
        trim: true,
    },
    checker_id: {
        type: String,
        trim: true,
    },
    checker_date: {
        type: Date,
    },
    checker_remarks: {
        type: String,
        trim: true,
    },
    checker_action: {
        type: String,
        enum: ['approved', 'rejected', null],
        default: null,
    },

    // Rejection reason
    rejection_reason: {
        type: String,
        trim: true,
    },

    request_type: {
        type: String,
        required: true,
        default: 'ECheck',
    },
    request_date: {
        type: Date,
        default: Date.now
    },
    assigned_date: {
        type: Date,
    },
    posted_date: {
        type: Date,
    },
    authorizer_name: {
        type: String,
    },
    authorized_date: {
        type: Date,
    },
    posted_by: {
        type: String,
    },
    assigned_to: {
        type: String,
    },
    assigned_by: {
        type: String,
    },
    audit_date: {
        type: Date,
    },
    audit_by: {
        type: String,
    },

    // SOAP transaction response
    flexcube_response: {
        type: Schema.Types.Mixed,
    },

    // Till update status
    till_updated: {
        type: Boolean,
        default: false,
    },
    till_update_date: {
        type: Date,
    },
});

// Pre-save hook to generate Queue_number and extract CIF
eCheckSchema.pre('save', async function (next) {
    try {
        // Generate Queue_number if not set (using E-Check counter)
        if (!this.Queue_number) {
            const sequence = await ECheckCounter.getNextSequence();
            this.Queue_number = 'EC' + String(sequence).padStart(6, '0');  // EC prefix for E-Check
        }

        // Extract CIF from account number (16-digit account)
        // CIF is 7 digits: from position 6 to 12 (0-indexed), or starting from end, exclude last 3, then take 7 digits
        if (this.account_number && this.account_number.length === 16 && !this.customer_cif) {
            // Account format: 1234567899876543
            // CIF extraction: exclude last 3 digits (543), then from right take 7 digits (7899876)
            const withoutLast3 = this.account_number.slice(0, -3); // 1234567899876
            this.customer_cif = withoutLast3.slice(-7); // 7899876
        }

        // Calculate denomination total if denomination is provided
        if (this.denomination) {
            this.denomination_total =
                (this.denomination.d200 || 0) * 200 +
                (this.denomination.d100 || 0) * 100 +
                (this.denomination.d50 || 0) * 50 +
                (this.denomination.d10 || 0) * 10 +
                (this.denomination.d5 || 0) * 5 +
                (this.denomination.d1 || 0) * 1 +
                (this.denomination.dc50 || 0) * 0.50 +
                (this.denomination.dc25 || 0) * 0.25 +
                (this.denomination.dc10 || 0) * 0.10 +
                (this.denomination.dc5 || 0) * 0.05 +
                (this.denomination.dc1 || 0) * 0.01;
        }

        next();
    } catch (error) {
        next(error);
    }
});

// Static method to generate XREF
eCheckSchema.statics.generateXref = async function () {
    return await XrefCounter.getNextXref();
};

// Static method to calculate denomination total
eCheckSchema.statics.calculateDenominationTotal = function (denomination) {
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
};

// Static method to auto-populate denomination based on amount
// Uses greedy algorithm to minimize number of notes/coins
eCheckSchema.statics.autopopulateDenomination = function (amount) {
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

    let remaining = Math.round(amount * 100) / 100; // Round to 2 decimal places
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
};

// Index for faster queries
eCheckSchema.index({ customer_cif: 1 });
eCheckSchema.index({ status: 1 });
// Index on xref already created by unique: true in schema definition
eCheckSchema.index({ account_number: 1, request_date: -1 });
// Compound indexes matching the list-screen query+sort shapes.
eCheckSchema.index({ branch: 1, status: 1, request_date: -1 });
// Teller auto-assignment counts today's tickets per teller in a branch (assignTellerBySystem).
eCheckSchema.index({ branch: 1, assigned_date: 1, assigned_to: 1 });
eCheckSchema.index({ assigned_to: 1, request_date: -1 });
eCheckSchema.index({ status: 1, posted_date: -1 });
// Date-range views: all branches (Branch_Management, admin search) and one branch's history.
eCheckSchema.index({ request_date: -1 });
eCheckSchema.index({ branch: 1, request_date: -1 });
// Teller/Admin search-by-customer within today's window (/transactions).
eCheckSchema.index({ Customer_Unique_Number: 1, request_date: -1 });

eCheckSchema.add(requestExpiryFields);
const ECheck = mongoose.model('ECheck', eCheckSchema);
export default ECheck;
