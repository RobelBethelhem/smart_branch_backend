import mongoose from "mongoose";
const Schema = mongoose.Schema;

const guarantySchema =  new Schema({
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

    employee_description: { 
        type: String,
        trim: true,
    },

    guaranty_first_name: { 
        type: String,
        required: true,
        trim: true,
    },
    guaranty_middle_name: { 
        type: String,
        required: true,
        trim: true,
    },
    guaranty_last_name: { 
        type: String,
        required: true,
        trim: true,
    },
    domain_user:{
        type: String,
        required: true,
        trim: true,
    },
    employee_count:{
        type: Number,
    },
    request_type:{
        type: String,
        trim: true,
        default: "Guranty"
    },

    employee_organization_location:{
        type: String,
        trim: true,
    },

    guaranty_organazation: { 
        type: String,
        required: true,
        trim: true,
    },

    viewed_by:{
        type: String,
        trim: true,
    },

    viewed_date:{
        type: Date,
    },

    status:{
        type: String,
        enum: ["Pending", "Viewed"],
        default: "Pending"
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


    const Guaranty = mongoose.model('Guaranty', guarantySchema);
    export default Guaranty;

    