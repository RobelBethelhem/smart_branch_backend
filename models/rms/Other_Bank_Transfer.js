import mongoose from "mongoose";
import DailyCounter from './DailyCounter.js';
const Schema = mongoose.Schema;

const other_bank_transferSchema =  new Schema({
    branch: { 
        type: String,
        trim: true,
    },
    acc_holder_name: { 
        type: String,
        required: true,
        trim: true,
    },

    reassigned_by:{
        type: String,
        trim: true
    },

    reassigned_Date:{
        type: Date,
    },

    
    telephone:{
        type: String,
        required: true,
        trim: true,
    },
    address:{
        type: String,
        required: true,
        trim: true,
    },
    request_type:{
        type: String,
        required: true,
        default: 'Other_Bank_Transfer',
    },
    amount_in_words: { 
        type: String,
        required: true,
        trim: true,
    },
    trn_ref_no:{
        type: String,
        trim: true,
        unique: true,
        sparse: true,
    },

    acc_holder_branch:{
        type: String,
        required: true,
        trim: true,
    },
    
    amount_in_figures:{
        type: String,
        required: true,  
        trim: true,
    },

    signature:{
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

    beneficiary_name:{
        type: String,
        required: true,
        trim: true,
    },

    beneficiary_bank:{
        type: String,
        required: true,
        trim: true,
    },

    beneficiary_branch:{
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
        enum: ['requested', 'assigned_by_csr', 'assigned', 'posted',  'authorized', 'audited', 'delayed'],
        default: 'requested',
        trim: true,
    },
    Queue_number:{
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
        default: Date.now
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
        trim: true,
    },
    assigned_to:{
        type: String,
        trim: true,
    },
    assigned_by:{
        type: String,
        trim: true,
    },
    audit_date:{
        type: Date,
    },
    audit_by:{
        type: String,
        trim: true,
    },
    });


    other_bank_transferSchema.pre('save', async function(next) {
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

    
    // Compound indexes matching the list-screen query+sort shapes (this model
    // previously had no indexes at all).
    other_bank_transferSchema.index({ branch: 1, status: 1, request_date: -1 });
    other_bank_transferSchema.index({ assigned_to: 1, request_date: -1 });
    other_bank_transferSchema.index({ status: 1, posted_date: -1 });
    // Teller auto-assignment counts today's tickets per teller in a branch (assignTellerBySystem).
    other_bank_transferSchema.index({ branch: 1, assigned_date: 1, assigned_to: 1 });
    // Date-range views: all branches (Branch_Management, admin search) and one branch's history.
    other_bank_transferSchema.index({ request_date: -1 });
    other_bank_transferSchema.index({ branch: 1, request_date: -1 });
    // Teller/Admin search-by-customer/account within today's window (/transactions).
    other_bank_transferSchema.index({ Customer_Unique_Number: 1, request_date: -1 });
    other_bank_transferSchema.index({ account_number: 1, request_date: -1 });

    const Other_Bank_Transfer = mongoose.model('Other_Bank_Transfer', other_bank_transferSchema);
    export default Other_Bank_Transfer;

    