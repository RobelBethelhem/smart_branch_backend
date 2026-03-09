import mongoose from "mongoose";
import DailyCounter from './DailyCounter.js';
import XrefCounter from './XrefCounter.js';

const Schema = mongoose.Schema;

const transferSchema = new Schema({
    branch: {
        type: String,
        trim: true,
    },
    acc_holder_name: {
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
    request_type: {
        type: String,
        required: true,
        default: 'Transfer',
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

    beneficiary_account_number: {
        type: String,
        required: true,
        trim: true,
    },

    beneficiary_branch: {
        type: String,
        required: true,
        trim: true,
    },

    beneficiary_name: {
        type: String,
        required: true,
        trim: true,
    },
    payment_narration: {
        type: String,
        required: true,
        trim: true,
    },
    trn_ref_no: {
        type: String,
        trim: true,
        unique: true,
        sparse: true,
    },

    // NEW: External Reference (16-digit auto-increment)
    xref: {
        type: String,
        trim: true,
        unique: true,
        sparse: true,
    },

    // NEW: Customer CIF (7 digits extracted from account number)
    customer_cif: {
        type: String,
        trim: true,
    },

    // NEW: Beneficiary CIF
    beneficiary_cif: {
        type: String,
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
            'pending_checker',   // NEW: Waiting for checker approval (amount >= threshold)
            'posted',
            'authorized',
            'audited',
            'delayed',
            'rejected'           // NEW: Rejected
        ],
        default: 'requested',
        trim: true,
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
        trim: true,
    },
    assigned_to: {
        type: String,
        trim: true,
    },
    assigned_by: {
        type: String,
        trim: true,
    },
    audit_date: {
        type: Date,
    },
    audit_by: {
        type: String,
        trim: true,
    },

    // NEW: Maker-checker fields
    needs_checker: {
        type: Boolean,
        default: false,
    },
    checker_threshold: {
        type: Number,
        default: 0,
    },
    checker_name: {
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

    // NEW: SOAP transaction response
    flexcube_response: {
        type: Schema.Types.Mixed,
    },

    // NEW: Rejection reason
    rejection_reason: {
        type: String,
        trim: true,
    },
});

// Pre-save hook to generate Queue_number and extract CIFs
transferSchema.pre('save', async function (next) {
    try {
        // Generate Queue_number if not set
        if (!this.Queue_number) {
            const sequence = await DailyCounter.getNextSequence();
            this.Queue_number = String(sequence).padStart(6, '0');
        }

        // Extract CIF from source account number (16-digit account)
        if (this.account_number && this.account_number.length === 16 && !this.customer_cif) {
            const withoutLast3 = this.account_number.slice(0, -3);
            this.customer_cif = withoutLast3.slice(-7);
        }

        // Extract CIF from beneficiary account number
        if (this.beneficiary_account_number && this.beneficiary_account_number.length === 16 && !this.beneficiary_cif) {
            const withoutLast3 = this.beneficiary_account_number.slice(0, -3);
            this.beneficiary_cif = withoutLast3.slice(-7);
        }

        next();
    } catch (error) {
        next(error);
    }
});

// Static method to generate XREF
transferSchema.statics.generateXref = async function () {
    return await XrefCounter.getNextXref();
};

// Index for faster queries
transferSchema.index({ customer_cif: 1 });
transferSchema.index({ beneficiary_cif: 1 });
transferSchema.index({ status: 1 });
// Index on xref already created by unique: true in schema definition
transferSchema.index({ account_number: 1, request_date: -1 });

const Transfer = mongoose.model('Transfer', transferSchema);
export default Transfer;
