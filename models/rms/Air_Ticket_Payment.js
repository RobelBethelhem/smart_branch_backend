import mongoose from "mongoose";
import requestExpiryFields from './requestExpiryFields.js';
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


    // KNOWN ISSUE, left as it is because air-ticket payments are not in use for now:
    // `unique: true` on the amount in words means a second air-ticket payment for the same
    // amount is rejected with a duplicate-key error (E11000 on index amount_in_words_1).
    // Before this feature is switched on: remove `unique: true` here AND drop that index in
    // MongoDB (db.air_ticket_payments.dropIndex("amount_in_words_1")); removing it here alone
    // does not delete an index that already exists.
    // Air-ticket payments also have no FlexCube posting route yet (they are only marked as
    // posted through /transaction_posted), so the posting lock in utils/rms/postingLock.js
    // does not cover them. Put any future air-ticket posting route under withPostingLock too.
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
        enum: ['requested', 'assigned_by_csr', 'assigned', 'posted',  'authorized', 'audited', 'delayed', 'expired'],  // expired: utils/rms/requestExpiry.js
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




    // Compound indexes matching the list-screen query+sort shapes (this model
    // previously had no indexes at all).
    air_ticket_paymentSchema.index({ branch: 1, status: 1, request_date: -1 });
    air_ticket_paymentSchema.index({ assigned_to: 1, request_date: -1 });
    air_ticket_paymentSchema.index({ status: 1, posted_date: -1 });
    // Teller auto-assignment counts today's tickets per teller in a branch (assignTellerBySystem).
    air_ticket_paymentSchema.index({ branch: 1, assigned_date: 1, assigned_to: 1 });
    // Date-range views: all branches (Branch_Management, admin search) and one branch's history.
    air_ticket_paymentSchema.index({ request_date: -1 });
    air_ticket_paymentSchema.index({ branch: 1, request_date: -1 });
    // Teller/Admin search-by-customer/account within today's window (/transactions).
    air_ticket_paymentSchema.index({ Customer_Unique_Number: 1, request_date: -1 });
    air_ticket_paymentSchema.index({ account_number: 1, request_date: -1 });

    air_ticket_paymentSchema.add(requestExpiryFields);
    const Air_Ticket_Payment = mongoose.model('Air_Ticket_Payment', air_ticket_paymentSchema);
    export default Air_Ticket_Payment;

    