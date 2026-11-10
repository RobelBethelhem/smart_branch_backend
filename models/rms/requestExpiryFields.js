// Fields every request model (deposit, withdraw, e-check, transfer, other-bank transfer,
// air-ticket payment) carries for end-of-day expiry. The rule itself is in
// utils/rms/requestExpiry.js.
const requestExpiryFields = {
    // When the request was closed as not served.
    expired_at: { type: Date },
    expiry_reason: { type: String, trim: true },
    // The status it had at that moment (requested, assigned, pending_checker ...), kept for the
    // audit trail and so an expiry can be traced or undone by hand.
    status_before_expiry: { type: String, trim: true },
};

export default requestExpiryFields;
