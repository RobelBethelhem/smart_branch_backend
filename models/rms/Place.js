import mongoose from "mongoose";
const Schema = mongoose.Schema;

const placeSchema = new Schema({
  country: {
    type: String,
    required: true,
    trim: true,
  },
  region: {
    type: String,
    required: true,
  },
  city: {
    type: String,
    unique: true,  // This should be unique
    required: true,
  },
  registered_By: {
    type: String,
    required: true,
  },
  Created_At: {
    type: Date,
    default: Date.now(),
  },
  Updated_At: {
    type: Date,
  },
  Updated_By: {
    type: String,
    trim: true,
  },
});

const Place = mongoose.model("Place", placeSchema);
export default Place;