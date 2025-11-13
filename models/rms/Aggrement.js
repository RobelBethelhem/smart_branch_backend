/* import mongoose from "mongoose";
const Schema = mongoose.Schema;

const aggrementSchema =  new Schema({
    // aggrement_file:{
    //     type:String,
    //     required:true
    // },
    room_id:{
        type: Schema.Types.ObjectId,
        required: true
    },
    customer_id:{
        type: Schema.Types.ObjectId,
        required: true
    },
    future_payment: { 
        type: String,
        required: true,
    },
    payment_type: { 
        type: [String],
        enum: ["Onetime","Installament"],
        default: ["Installament"],
    },
    customer_paid:{
        type: Number,
        default: 0,
    },
    interest_over_due:{
        type: Number,
        default: 0,
    },
    Number_of_installment:{
        type: Number,
    },
    Date_of_Payment:{
        type: [Date],
    },

    payment_status: {
        type: [String],
        enum: ["Normal","10dayUnpaid", "15dayUnpaid", "1monthUnpaid", "3monthUnpaid", "9monthUnpaid", "escalte","legalcase", "Finished"],
        default: ["Normal"],
    },
    registered_By: {
        type: String,
        required: true
    },
    Created_At:{
        type: Date,
        default: Date.now(),
    },
    Updated_At:{
        type: Date,
    },

    Updated_By:{
        type: String,
        trim: true
    }

    });

    const Aggrement = mongoose.model("Aggerement",aggrementSchema);
    export default Aggrement; */

import mongoose from "mongoose";


const penalitySchema = new mongoose.Schema({
    penality_amount_per_day: { type: Number},
    amount_for_agreement_cancel:{type: Number},
    amount_for_legal_case:{type: Number},
    registered_By: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
    updated_By: { type: String, trim: true }
})

const special_case_no_penalitySchema = new mongoose.Schema({
    start_date:{type: Date},
    end_date: {type: Date},
    registered_By: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
    updated_By: { type: String, trim: true }
})

const restructureInstallementSchema = new mongoose.Schema({
    name: {
        type: String
    },
    amount: { 
        type: Number,
        required: true,
    
    },
    installment: {
        type: Number
    },
    dueDate: {
        type: Date,
        required: true
    },
    paidDate: {
        type: Date,
    },

    unpaid_date_difference: {
        type: Number,
        default: 0
    },
    payment: {
        type: Number,
        default: 0
    },

    principalPayment:{
        type: Number,
        default: 0
    },
    interestPayment: {
        type: Number,
        default: 0
    },
    remainingBalance: {
        type: Number,
        default: 0
    },
    left_amount: {
        type: Number,
        default: 0
    },
    accrue_left_amount:{
        type: Number,
        default: 0
    },
    paid: { 
        type: Boolean,
        default: false
    },
    status: {
        type: String,
         enum: ["Paid", "Partially Paid","Paid Late", "Unpaid"],
        default: "Unpaid"
    },
    registered_By: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
    updated_By: { type: String, trim: true }
})



const installmentSchema = new mongoose.Schema({
    name:{
        type: String,
        default: 'main'
    },
    amount: { 
        type: Number,
        required: true,
    
    },
    installment: {
        type: Number
    },
    dueDate: {
        type: Date,
        required: true
    },
    paidDate: {
        type: Date,
    },

    unpaid_date_difference: {
        type: Number,
        default: 0
    },
    payment: {
        type: Number,
        default: 0
    },

    principalPayment:{
        type: Number,
   
    },
    interestPayment: {
        type: Number,
    
    },
    remainingBalance: {
        type: Number,
        
    },
    left_amount: {
        type: Number,
        default: 0
    },
    accrue_left_amount:{
        type: Number,
        default: 0
    },
    paid: { 
        type: Boolean,
        default: false
    },
    status: {
        type: String,
        enum: ["false", "true"],
        default: "false"
    },
    registered_By: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
    updated_By: { type: String, trim: true }
});
const restructure_agreementSchema = new mongoose.Schema({
    
    grace_period_restructure:{
        type: Number,
    },
    discount_rate_restructure:{
        type: Number,
    },
    Percent_per_day_penality_restructure:{
        type: Number,
    },
    repayment_started: {
        type: Date,
        default: function(){
            return new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
        }
    },
    registered_By: { type: String },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
    updated_By: { type: String, trim: true }
})

const agreementSchema = new mongoose.Schema({
    room_id: { 
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Room',
        required: true 
    },
    customer_id: { 
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Customer',
        required: true 
    },
    site_id: {
        type: mongoose.Schema.Types.ObjectId,
        
    },
    customer_name: {
        type: String,
        required: true,
        trim: true  
    },
    payment_type: {
        type: String,
        enum: ["Onetime", "Installment"],
        default: "Installment"
    },
    payment_period: {
        type: String,
        enum: ["monthly", "quarterly", "yearly"],
        default: "monthly"
    },

    base_payment: {
        type: Number,
        required: true
    },
    base_payment_percent: {
        type: Number,
        enum: [20,25,30, 35, 40, 45],
        default: 30
    },
    payment_duration: {
        type: Number,
        enum: [5, 10, 15, 20,25,30],
        default: 20
    },
    repayment_started: {
        type: Date,
    },
    repayment_end: {
        type: Date,
    },
    
    // interest_over_due: { type: Number, default: 0 },
    income: { type: Number, default: 0 },
    installments: [installmentSchema],
    restructure_installments: [restructureInstallementSchema],
    restructure_agreement: [restructure_agreementSchema],
    special_case_no_penality: [special_case_no_penalitySchema],
    penalities: [penalitySchema],
    aggerement_status: {
        type: String,
        enum: ["Ongoing","Completed", "Legal_case","Cancel"],
        default: "Ongoing"
    },
    amount_receivable: { type: Number, required: true },

    grace_period:{
        type: Number,
        default: 60
    },
    grace_period_restructure:{
        type: Number,
    },
    discount_rate:{
        type: Number,
    },
    discount_rate_restructure:{
        type: Number,
    },
    Percent_per_day_penality_restructure:{
        type: Number,
    },
    Percent_per_day_penality:{
        type: Number
    },
    penality_to_pay: {
        type: Number,
        default: 0,
    },
    percent_the_customer_to_live:{
        type: Number,
        default: 0,
    },
    when_legal_case:{
        type: Number,
    },
    when_agreement_cancel:{
        type: Number,
    },
    registered_By: { type: String, required: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date },
    updated_By: { type: String, trim: true }
});

const Agreement = mongoose.model("Agreement", agreementSchema);

export { Agreement };