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

    
    const Other_Bank_Transfer = mongoose.model('Other_Bank_Transfer', other_bank_transferSchema);
    export default Other_Bank_Transfer;

    