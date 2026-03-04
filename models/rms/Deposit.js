import mongoose from "mongoose";
import DailyCounter from './DailyCounter.js';
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

const depositSchema = new Schema({
    branch: {
        type: String,
        trim: true,
    },
    acc_holder_name: {
        type: String,
        required: true,
        trim: true,
    },
    amount_in_words: {
        type: String,
        required: true,
        trim: true,
    },
    request_type: {
        type: String,
        default: 'Deposit',
    },
    amount_in_figures: {
        type: String,
        required: true,
        trim: true,
    },

    source_of_funds: {
        type: String,
        required: true,
        trim: true,
    },
    signature: {
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

    account_number: {
        type: String,
        required: true,
        trim: true,
    },
    deposited_by: {
        type: String,
        required: true,
        trim: true,
    },

    depositor_address: {
        city: {
            type: String,
            required: false,
            trim: true
        },
        subcity: {
            type: String,
            required: false,
            trim: true
        },
        woreda: {
            type: String,
            required: false,
            trim: true
        },
        house_number: {
            type: String,
            required: false,
            trim: true
        },
        telephone: {
            type: String,
            required: false,
            trim: true
        }
    },

    reassigned_by: {
        type: String,
        trim: true
    },

    reassigned_Date: {
        type: Date,
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

    // NEW: Customer CIF (7 digits extracted from account number)
    customer_cif: {
        type: String,
        trim: true,
    },

    // NEW: Denomination breakdown for cash deposit
    denomination: denominationSchema,

    // NEW: Calculated total from denomination
    denomination_total: {
        type: Number,
        default: 0,
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

    request_date: {
        type: Date,
        default: new Date().toISOString()
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

    // NEW: SOAP transaction response
    flexcube_response: {
        type: Schema.Types.Mixed,
    },

    // NEW: Till update status
    till_updated: {
        type: Boolean,
        default: false,
    },
    till_update_date: {
        type: Date,
    },
});

// Pre-save hook to generate Queue_number and extract CIF
depositSchema.pre('save', async function (next) {
    try {
        // Generate Queue_number if not set
        if (!this.Queue_number) {
            const sequence = await DailyCounter.getNextSequence();
            this.Queue_number = String(sequence).padStart(6, '0');
        }

        // Extract CIF from account number (16-digit account)
        if (this.account_number && this.account_number.length === 16 && !this.customer_cif) {
            const withoutLast3 = this.account_number.slice(0, -3);
            this.customer_cif = withoutLast3.slice(-7);
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
depositSchema.statics.generateXref = async function () {
    return await XrefCounter.getNextXref();
};

// Static method to calculate denomination total
depositSchema.statics.calculateDenominationTotal = function (denomination) {
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

// Index for faster queries
depositSchema.index({ customer_cif: 1 });
depositSchema.index({ status: 1 });
depositSchema.index({ xref: 1 });
depositSchema.index({ account_number: 1, request_date: -1 });

const Deposit = mongoose.model('Deposit', depositSchema);
export default Deposit;


/* ============================================
 * COMMENTED OUT - Previous Implementation
 * ============================================
 *
 * The previous Deposit model without denomination, XREF fields.
 * Keeping for reference.
 *
import mongoose from "mongoose";
import DailyCounter from './DailyCounter.js';


const Schema = mongoose.Schema;

const depositSchema =  new Schema({
    branch: {
        type: String,
        trim: true,
    },
    acc_holder_name: {
        type: String,
        required: true,
        trim: true,
    },
    amount_in_words: {
        type: String,
        required: true,
        trim: true,
    },
    request_type:{
        type: String,
        default: 'Deposit',
    },
    amount_in_figures:{
        type: String,
        required: true,
        trim: true,
    },

    source_of_funds:{
        type: String,
        required: true,
        trim: true,
    },
    signature:{
        type: String,
        required: true,
        trim: true,
    },
    trn_ref_no:{
        type: String,
        trim: true,
    },
    account_number: {
        type: String,
        required: true,
        trim: true,
    },
    deposited_by:{
        type: String,
        required: true,
        trim: true,
    },

    depositor_address: {
        city: {
            type: String,
            required: false,
            trim: true
        },
        subcity: {
            type: String,
            required: false,
            trim: true
        },
        woreda: {
            type: String,
            required: false,
            trim: true
        },
        house_number: {
            type: String,
            required: false,
            trim: true
        },
        telephone: {
            type: String,
            required: false,
            trim: true
        }
    },

    reassigned_by:{
        type: String,
        trim: true
    },

    reassigned_Date:{
        type: Date,
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
        enum: ['requested', 'assigned_by_csr', 'assigned', 'posted',  'authorized', 'audited', 'delayed'],
        default: 'requested',
        trim: true,
    },
    Queue_number: {
        type: String,
        required: false,
        trim: true,
    },
    Customer_Unique_Number:{
        type: String,
        required: true,
        unique: true,
        trim: true,
    },
    request_date:{
        type: Date,
        default: new Date().toISOString()
    },
    assigned_date:{
        type: Date,
    },
    posted_date:{
        type: Date,
    },
    authorizer_name:{
        type: String,
    },
    authorized_date:{
        type: Date,
    },
    posted_by:{
        type: String,
    },
    assigned_to:{
        type: String,
    },
    assigned_by:{
        type: String,
    },
    audit_date:{
        type: Date,
    },
    audit_by:{
        type: String,
    },
    });



    depositSchema.pre('save', async function(next) {
        try {
            if (!this.Queue_number) {  // Only generate if not already set
                const sequence = await DailyCounter.getNextSequence();
                this.Queue_number = String(sequence).padStart(6, '0');
            }
            next();
        } catch (error) {
            next(error);
        }
    });


    const Deposit = mongoose.model('Deposit', depositSchema);
    export default Deposit;
 *
 * ============================================
 */
