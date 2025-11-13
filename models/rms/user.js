

import mongoose from "mongoose";
const Schema = mongoose.Schema;

const userSchema =  new Schema({
    user: { 
        type: String,
        required: true,
        trim: true,
    },
    email: { 
        type: String,
        required: true,
        unique: true,
    },
    roles: { 
        type: [String],
        enum: ["Teller","CSR","Admin", "Authorizer", "Auditor", "Branch_Management", "KYC", "Super_Admin", "Maker"],
        default: ["Teller"],
    },
    
    branch: { 
        type: String,
        required: true,
        trim: true,
    },
    till_id: { 
        type: String,
        trim: true,
    },
    flex_id: { 
        type: String,
       
        trim: true,
    },
    Created_at:{
        type: Date,
        default: new Date()
    },
    password: { 
        type: String,
        required: true,
        default: "$2b$10$SEfTATgmvwERsC4ID3TKgebRUJ03yId2hVZeALA22Zq.QAVj4CYV."
    },

    // Created_by:{
    //     type: String,
    //     required: true,
    // },
    });

   // const User = mongoose.model("User",userSchema);

    const User = mongoose.models.User || mongoose.model('User', userSchema);
    export default User;

    