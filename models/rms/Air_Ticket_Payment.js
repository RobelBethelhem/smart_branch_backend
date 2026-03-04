import mongoose from "mongoose";
import DailyCounter from './DailyCounter.js';
const Schema = mongoose.Schema;

const air_ticket_paymentSchema =  new Schema({
    branch: { 
        type: String,
        required: true,
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


    amount_in_words: { 
        type: String,
        required: true,
        unique: true,
        trim: true,
    },
    request_type:{
        type: String,
        required: true,
        default: 'Air_Ticket_Payment',
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
    telephone:{
        type: String,
        required: true,
        trim: true,
    },

    trn_ref_no:{
        type: String,
        trim: true,
    },
    
    payment_method: { 
        type: String,
        required: true,
        enum: ['Cash', 'Cheque', 'account_number'],
        default: 'account_number',
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
        required: true,
    },
    });



    air_ticket_paymentSchema.pre('save', async function(next) {
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




    const Air_Ticket_Payment = mongoose.model('Air_Ticket_Payment', air_ticket_paymentSchema);
    export default Air_Ticket_Payment;

    