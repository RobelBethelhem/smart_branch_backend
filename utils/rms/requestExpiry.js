import mongoose from "mongoose";
import Deposit from "../../models/rms/Deposit.js";
import Withdraw from "../../models/rms/Withdraw.js";
import ECheck from "../../models/rms/ECheck.js";
import Transfer from "../../models/rms/Transfer.js";
import Other_Bank_Transfer from "../../models/rms/Other_Bank_Transfer.js";
import Air_Ticket_Payment from "../../models/rms/Air_Ticket_Payment.js";

// End-of-day expiry of customer requests.
//
// The rule: a request (and its reference code) is valid until the end of the day it was made.
// If it has not been posted to FlexCube by then, it is closed with the final status "expired"
// and the customer has to make a new request. Nothing is deleted: the record stays, with the
// time it expired, the reason and the status it had.
//
//  • Only requests that have moved NO money expire: requested, assigned, assigned_by_csr,
//    delayed, and pending_checker (the maker has submitted it, the checker has not approved
//    it, so nothing has been posted yet).
//  • A request that HAS been posted (posted, authorized, audited) never expires. It stays in
//    the Authorizer's and Auditor's lists on the following days (CARRY_OVER_DAYS) until done.
//  • "End of the day" is midnight on the server's clock (TZ=Africa/Addis_Ababa in the image).
//
// Two things enforce it, so neither depends on the other:
//  1. A sweep (at start-up, then every SWEEP_MINUTES) marks overdue requests as expired.
//  2. The routes that act on a request check the date themselves (isExpiredRequest /
//     expireIfDue), so a request cannot be assigned or posted in the minutes between midnight
//     and the next sweep, or if the sweep is not running.

export const EXPIRED_STATUS = 'expired';
export const EXPIRING_STATUSES = ['requested', 'assigned', 'assigned_by_csr', 'delayed', 'pending_checker'];
export const EXPIRY_REASON = 'Not completed by the end of the day it was requested';
export const EXPIRED_MESSAGE =
    'This request has expired: it was not completed on the day it was made. The customer has to make a new request.';

const SWEEP_MINUTES = 10;

const REQUEST_MODELS = [Deposit, Withdraw, ECheck, Transfer, Other_Bank_Transfer, Air_Ticket_Payment];
// The names the posting routes use for a kind of request (see withPostingLock).
const MODEL_BY_KIND = { Deposit, Withdraw, ECheck, Transfer };

export const startOfDay = (now = new Date()) => {
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    return start;
};

/** True for a request that is expired, or should be (still open on a later day). */
export const isExpiredRequest = (request, now = new Date()) => {
    if (!request) return false;
    if (request.status === EXPIRED_STATUS) return true;
    return EXPIRING_STATUSES.includes(request.status)
        && !!request.request_date
        && new Date(request.request_date) < startOfDay(now);
};

// Marks the matching overdue requests as expired, keeping the status they had. Written to the
// collection directly because the old status is copied in the same update (a pipeline update),
// which Mongoose does not cast. Running it twice changes nothing the second time.
const markExpired = async (Model, filter, now) => {
    const result = await Model.collection.updateMany(
        { ...filter, status: { $in: EXPIRING_STATUSES }, request_date: { $lt: startOfDay(now) } },
        [{ $set: {
            status_before_expiry: '$status',
            status: EXPIRED_STATUS,
            expired_at: now,
            expiry_reason: EXPIRY_REASON,
        } }]
    );
    return result.modifiedCount || 0;
};

/**
 * For a route that is about to act on one request: is it expired? If it is overdue but not
 * yet marked, it is marked now.
 * @param {string} kind 'Deposit' | 'Withdraw' | 'ECheck' | 'Transfer'
 * @returns {Promise<boolean>} true = refuse the action
 */
export async function expireIfDue(kind, id, now = new Date()) {
    const Model = MODEL_BY_KIND[kind];
    if (!Model || !mongoose.isValidObjectId(id)) return false;   // the route answers those itself
    const request = await Model.findById(id).select('status request_date').lean();
    if (!isExpiredRequest(request, now)) return false;
    if (request.status !== EXPIRED_STATUS) await markExpired(Model, { _id: request._id }, now);
    return true;
}

/** Marks every overdue request in all six collections. Returns how many were changed. */
export async function expireOverdueRequests(now = new Date()) {
    const counts = await Promise.all(REQUEST_MODELS.map((Model) => markExpired(Model, {}, now)));
    const total = counts.reduce((a, b) => a + b, 0);
    if (total > 0) {
        const detail = REQUEST_MODELS.map((Model, i) => (counts[i] ? `${Model.modelName} ${counts[i]}` : null)).filter(Boolean).join(', ');
        console.log(`[REQUEST_EXPIRY] ${total} request(s) not completed on the day they were made are now expired (${detail})`);
    }
    return total;
}

// How many earlier days of posted-but-unfinished work the Authorizer's and Auditor's lists
// show besides today's. Older items are still counted in Branch Record's warning.
export const carryOverStart = (now = new Date()) => {
    const days = Number(process.env.CARRY_OVER_DAYS);
    const start = startOfDay(now);
    start.setDate(start.getDate() - (Number.isFinite(days) && days >= 0 ? Math.floor(days) : 7));
    return start;
};

/** Starts the sweep: once as soon as MongoDB is connected, then every SWEEP_MINUTES. */
export function startRequestExpirySweep() {
    let running = false;
    const sweep = async () => {
        if (running || mongoose.connection.readyState !== 1) return;
        running = true;
        try {
            await expireOverdueRequests();
        } catch (e) {
            console.error('[REQUEST_EXPIRY] sweep failed:', e?.message);
        } finally {
            running = false;
        }
    };
    mongoose.connection.on('connected', sweep);
    const timer = setInterval(sweep, SWEEP_MINUTES * 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();
    sweep();
}
