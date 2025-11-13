import mongoose from "mongoose";
const Schema = mongoose.Schema;

const floorSchema =  new Schema({
    floor: { 
        type: String,
        required: true,
        trim: true,
    },
    floor_description: {
        type: String,
        trim: true,
        required: true,
    },
    building_id:{
        type: Schema.Types.ObjectId,
        required: true
    },
    site_id: {
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

    const Floor = mongoose.model("Floor",floorSchema);
    export default Floor;

    