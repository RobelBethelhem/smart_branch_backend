import mongoose from "mongoose";
const Schema = mongoose.Schema;

const customerSchema =  new Schema({
    customer_name: { 
        type: String,
        required: true,
        unique: true,
        trim: true,
    },
    customer_email: { 
        type: String,
        required: true,
        unique: true,
    },
    customer_phone_number: { 
        type: String,
        unique: true,
        required: true,
    },

    customer_address:{
        type: String,
        required: true
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

    const Customer = mongoose.model("Customer",customerSchema);
    export default Customer;

    