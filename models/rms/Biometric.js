import mongoose from "mongoose";
const Schema = mongoose.Schema;

const biometricSchema = new Schema({
    cif: {
        type: String,
        required: true,
        trim: true,
        minlength: 7,
        maxlength: 7,
        validate: {
            validator: function(v) {
                return /^\d{7}$/.test(v);
            },
            message: props => `${props.value} is not a valid 7-digit CIF number!`
        }
    },
    fingerprint_template: {
        type: String,
        required: true,
    },
    finger_position: {
        type: String,
        enum: ['right_thumb', 'right_index', 'right_middle', 'right_ring', 'right_little',
               'left_thumb', 'left_index', 'left_middle', 'left_ring', 'left_little'],
        default: 'right_index',
    },
    status: {
        type: String,
        required: true,
        enum: ['pending', 'approved', 'rejected'],
        default: 'pending',
    },
    branch: {
        type: String,
        required: true,
        trim: true,
    },
    registered_by: {
        type: String,
        required: true,
        trim: true,
    },
    registered_by_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
    },
    registration_date: {
        type: Date,
        default: Date.now,
    },
    approved_by: {
        type: String,
        trim: true,
    },
    approved_by_id: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
    },
    approval_date: {
        type: Date,
    },
    rejection_reason: {
        type: String,
        trim: true,
    },
    customer_name: {
        type: String,
        trim: true,
    },
    account_number: {
        type: String,
        trim: true,
    },
    is_simulated: {
        type: Boolean,
        default: false,
    },
});

// Index for faster lookup by CIF and status
biometricSchema.index({ cif: 1, status: 1 });
biometricSchema.index({ branch: 1, status: 1 });
// my_registrations filters by the enrolling user and sorts by date.
biometricSchema.index({ registered_by_id: 1, registration_date: -1 });

const Biometric = mongoose.models.Biometric || mongoose.model('Biometric', biometricSchema);
export default Biometric;
