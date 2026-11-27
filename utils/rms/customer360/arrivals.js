// Records "the customer of this request is with a teller now", which is what the Customer 360
// notification in the backoffice is made from.
//
// Called at the two moments a request gets a teller:
//   - the customer asked for a teller and the system chose one (assigned_by "system"),
//   - a teller took a waiting request herself (assigned_by "teller").
// A request the customer only wanted a code for has no teller yet, so nothing is recorded
// until a teller takes it.
//
// Nothing here may disturb the request itself: every failure is logged and swallowed.

import { CustomerArrival } from "../../../models/rms/Customer360.js";

export const REQUEST_TYPE_LABELS = {
    deposit: "Deposit",
    withdraw: "Withdrawal",
    echeck: "E-cheque",
    "e-check": "E-cheque",
    transfer: "Transfer",
    other_bank_transfer: "Other bank transfer",
    air_ticket_payment: "Air ticket payment",
};

// Account numbers are 16 digits; the customer number is digits 7 to 13 (as everywhere else
// in this system).
export const cifFromAccount = (accountNumber) => {
    const account = String(accountNumber || "").trim();
    return /^\d{16}$/.test(account) ? account.substring(6, 13) : "";
};

async function save(request, requestType, assignedBy) {
    if (!request || !request.assigned_to || !request.branch) return;
    const account = String(request.account_number || "").trim();
    const requestId = String(request._id);

    await CustomerArrival.updateOne(
        { request_id: requestId },
        {
            $setOnInsert: {
                request_id: requestId,
                branch: String(request.branch),
                request_type: String(requestType || "").toLowerCase(),
                customer_name: String(request.acc_holder_name || "").trim(),
                account_number: account,
                cif: String(request.customer_cif || "").trim() || cifFromAccount(account),
                queue_number: request.Queue_number === undefined || request.Queue_number === null ? "" : String(request.Queue_number),
                assigned_to: String(request.assigned_to),
                assigned_by: assignedBy,
                simulated: false,
                arrived_at: new Date(),
                seen_by: [],
            },
        },
        { upsert: true }
    );
}

/** For a request document that is already in memory (system assignment at creation). */
export function recordArrival(request, requestType, assignedBy = "system") {
    save(request, requestType, assignedBy).catch((error) => {
        console.error("[CUSTOMER360] could not record the arrival:", error.message);
    });
}

/**
 * A request was given to another teller (Reassignment screen). The arrival follows it, so
 * that a teller who only sees her own customers sees the right ones.
 */
export function moveArrivals(requestIds, teller) {
    const ids = (requestIds || []).map((id) => String(id));
    if (ids.length === 0 || !teller) return;
    CustomerArrival.updateMany({ request_id: { $in: ids } }, { $set: { assigned_to: String(teller) } })
        .catch((error) => {
            console.error("[CUSTOMER360] could not move the arrival to the new teller:", error.message);
        });
}

/** For a request that was just updated in the database (a teller took it). */
export function recordArrivalById(Model, id, requestType, assignedBy = "teller") {
    Model.findById(id)
        .select("branch acc_holder_name account_number customer_cif Queue_number assigned_to")
        .lean()
        .then((request) => save(request, requestType, assignedBy))
        .catch((error) => {
            console.error("[CUSTOMER360] could not record the arrival:", error.message);
        });
}
