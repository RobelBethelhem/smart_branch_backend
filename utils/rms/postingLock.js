import { AsyncLocalStorage } from "node:async_hooks";
import PostingLock from "../../models/rms/PostingLock.js";
import UnrecordedPosting from "../../models/rms/UnrecordedPosting.js";

// Stops one transaction from being posted to FlexCube twice.
//
// The posting routes read the transaction, check that it is still waiting ("assigned", or
// "pending_checker" for the checker), post to FlexCube, and only then save the new status.
// That left two ways to move the money twice:
//
//  1. Two requests close together (a double click, a retry after a slow response, two
//     checkers approving the same item). Both passed the status check before either had
//     saved, and both posted.
//  2. FlexCube accepted the posting but saving the result then failed (database unreachable,
//     record failing validation). The transaction still looked unposted, so the next attempt
//     posted it again.
//
// withPostingLock() runs a route handler so that neither can happen:
//   - A lock on that one transaction is taken BEFORE the handler reads it, so the handler
//     always sees the status the previous request left behind. A second request while the
//     first is running is answered at once with HTTP 409. A second request after the first
//     has finished gets the lock, reads the new status and is refused by the handler's own
//     check ("Cannot process ... with status: posted").
//   - If FlexCube accepted a posting during the request and the request still ended in an
//     error, that is written down (UnrecordedPosting) and every later attempt is refused with
//     the FlexCube reference, until a person has sorted it out.
// The handler itself is not changed, so every response it gave before is the same.
//
// The lock spans the maker's posting and the checker's approval of the same transaction
// (same kind and id), so those two cannot overlap either.

const BUSY_MESSAGE = "This transaction is already being processed. Please wait a moment, then refresh the list.";
const unrecordedMessage = (ref) =>
    `This transaction was already posted to FlexCube${ref ? ` (reference ${ref})` : ""} but the result could not be saved. ` +
    "Do NOT post it again. Please report it to IT support.";

const lockKey = (kind, id) => `${kind}:${String(id).trim().toLowerCase()}`;

// Carries "FlexCube accepted a posting during this request" from the FlexCube service back to
// the wrapper, without the route handlers having to pass anything along.
const postingContext = new AsyncLocalStorage();

/** Called by FlexcubeTransactionService when FlexCube reports SUCCESS for a posting. */
export function notePostedToFlexcube(trnRefNo) {
    const context = postingContext.getStore();
    if (context) {
        context.posted = true;
        context.trnRefNo = trnRefNo || context.trnRefNo || null;
    }
}

/**
 * @param {(req) => string|undefined} getKind  e.g. () => 'Withdraw'
 * @param {(req) => string|undefined} getId    the transaction id from the request
 * @param {Function} handler                   the original (req, res, next) route handler
 */
export function withPostingLock(getKind, getId, handler) {
    return async (req, res, next) => {
        const kind = getKind(req);
        const id = getId(req);

        // No id / kind: let the handler give its usual "... is required" answer. Any other
        // value is locked under its text form, so an id sent in an unusual shape cannot get
        // around the lock.
        if (!kind || !id) {
            return handler(req, res, next);
        }

        const key = lockKey(kind, id);
        const lockedBy = req.user?.user || req.user?._id?.toString();
        try {
            await PostingLock.create({ _id: key, locked_by: lockedBy });
        } catch (e) {
            if (e?.code === 11000) {
                console.warn(`[POSTING_LOCK] ${key} is already being processed - duplicate request refused`);
                return res.status(409).json({ error: true, message: BUSY_MESSAGE });
            }
            // Could not reach MongoDB: do not post without the lock.
            console.error(`[POSTING_LOCK] could not lock ${key}:`, e?.message);
            return res.status(500).json({ error: true, message: "Failed to process transaction" });
        }

        const context = { posted: false, trnRefNo: null };
        try {
            // Inside the lock: was an earlier posting of this transaction accepted by FlexCube
            // without being saved? Then it must not be posted again.
            const unrecorded = await UnrecordedPosting.findById(key).lean();
            if (unrecorded) {
                console.error(`[POSTING_LOCK] ${key} refused: already posted to FlexCube as ${unrecorded.trn_ref_no} but not saved`);
                return res.status(409).json({
                    error: true,
                    message: unrecordedMessage(unrecorded.trn_ref_no),
                    data: { flexcubeTrnRef: unrecorded.trn_ref_no }
                });
            }

            await postingContext.run(context, () => handler(req, res, next));
        } catch (e) {
            // The handlers answer their own errors; this is only for a failure around them.
            console.error(`[POSTING_LOCK] ${key} failed:`, e?.message);
            if (!res.headersSent) {
                res.status(500).json({ error: true, message: "Failed to process transaction" });
            }
        } finally {
            // FlexCube took the money movement, but the request did not end in success: the
            // new status was most likely not saved. Remember it before letting go of the lock.
            if (context.posted && res.statusCode >= 400) {
                console.error(`[POSTING_LOCK] ${key} was POSTED to FlexCube (${context.trnRefNo}) but the request ended with HTTP ${res.statusCode}. Further posting of it is blocked.`);
                try {
                    await UnrecordedPosting.updateOne(
                        { _id: key },
                        { $setOnInsert: { kind, transaction_id: String(id), trn_ref_no: context.trnRefNo, posted_by: lockedBy, response_status: res.statusCode, createdAt: new Date() } },
                        { upsert: true }
                    );
                } catch (e) {
                    console.error(`[POSTING_LOCK] could not record the unsaved posting of ${key}:`, e?.message);
                }
            }
            try {
                await PostingLock.deleteOne({ _id: key });
            } catch (e) {
                // The lock then expires by itself (TTL index on PostingLock.createdAt).
                console.error(`[POSTING_LOCK] could not release ${key}:`, e?.message);
            }
        }
    };
}
