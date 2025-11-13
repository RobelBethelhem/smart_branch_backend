import mongoose from "mongoose";
const Schema = mongoose.Schema;

const buildingSchema =  new Schema({
    building_name: { 
        type: String,
        required: true,
        trim: true,
    },
    total_floor: {
        type: String,
        required: true,
        trim: true,
    },
    special_feature: {
        type: String,
        trim: true
    },
    site_id:{
        type: Schema.Types.ObjectId,
      
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

    const Building = mongoose.model("Building",buildingSchema);
    export default Building;
