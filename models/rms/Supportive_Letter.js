import mongoose from "mongoose";
const Schema = mongoose.Schema;

const supportiveSchema =  new Schema({
    employee_first_name: { 
        type: String,
        required: true,
        trim: true,
    },
    employee_middle_name: { 
        type: String,
        required: true,
        trim: true,
    },
    employee_last_name: { 
        type: String,
        required: true,
        trim: true,
    },
    employee_organazation: { 
        type: String,
        required: true,
        trim: true,
    },
    employee_count:{
        type: Number,
    },

    employee_description: { 
        type: String,
        trim: true,
    },
    employee_organization_location:{
        type: String,
        trim: true,
    },
    domain_user:{
        type: String,
        required: true,
        trim: true,
    },
    status:{
        type: String,
        enum: ["Pending", "Viewed"],
        default: "Pending"
    },

    request_type:{
        type: String,
        trim: true,
        default: "Supportive"
    },


    viewed_by:{
        type: String,
        trim: true,
    },

    viewed_date:{
        type: Date,
    },
    
    TimeStamp:{
        type: Date,
        default: new Date()
    },


    request_day_amharic:{
        type: String,
        trim: true,
    },
    approved_day_amharic:{
        type: String,
        trim: true,
    },
    salary:{
        type: String,
        trim: true,
    }
    
    });


    const Supportive = mongoose.model('Supportive', supportiveSchema);
    export default Supportive;

    