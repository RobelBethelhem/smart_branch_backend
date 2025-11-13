import mongoose from "mongoose";
const Schema = mongoose.Schema;

const siteSchema =  new Schema({
    site_name: { 
        type: String,
        required: true,
        trim: true,
    },
    description: {
        type: String,
        required: true,
        trim: true,
    },
    place_id:{
        type: Schema.Types.ObjectId,
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

    const Site = mongoose.model("Site",siteSchema);
    export default Site;

    