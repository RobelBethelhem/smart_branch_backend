# Known issues and deferred work

Found during the performance review for the 500+ user rollout (November 2026). None of these
were changed, either because they are not about performance (your decision: report only) or
because the change could not be proven to behave the same without FlexCube and DBA testing.

File and line references are to the code as of that review.

## Bugs (not performance) — `smart_branch_backend`

| # | Where | Problem | Suggested fix |
|---|---|---|---|
| B1 | `routes/rms/ZSmartBrannchRequests.js`, posting routes | ~~A transaction submitted twice quickly could be posted to FlexCube twice.~~ **Fixed** for withdraw, e-check, deposit, transfer and the checker's approval. See "Double posting" below | — |
| B2 | `routes/rms/auth.js` `/verify-token` | On a missing or blacklisted token it answers 401 and then continues and answers 200 as well (no `return`). An expired token answers 500 and logs a stack trace every time | `return` after each response; answer 401 for JWT errors |
| B3 | `routes/rms/refreshToken.js:22` | Reads `tokenDetail._id`, which is always undefined (the data is under `tokenDetail.tokenDetails`) | Read the right field |
| B4 | `ZSmartBrannchRequests.js`, edit and delete routes | The "does it exist" check uses `Promise.any` over `findOne`. A collection that returns `null` still counts as found, so the check passes by chance | Check all results and use the first non-null one |
| B5 | `assignTellerBySystem` | Kiosks submitting at the same moment read the same ticket counts and all pick the same teller | Accept (self-corrects on the next ticket) or assign through an atomic counter per teller |
| B6 | `smart_branch_backoffice/src/views/admin/Chat/chat.js:787` | After "Assign" it calls `fetchData()` without the search term; the server answers 400 and the table is not refreshed | `fetchData(searchTerm)` |
| B7 | `smart_branch_backend/models/rms/Air_Ticket_Payment.js` | `amount_in_words` is declared `unique: true`. A second air-ticket payment for the same amount is rejected with a duplicate-key error. **Left as it is on purpose** (air-ticket payments are not in use); the code carries a comment explaining it | Before switching the feature on: remove `unique` from that field and drop the `amount_in_words_1` index in MongoDB |
| B8 | `smart_branch_backoffice/src/views/pages/login/Login.js:147` | The login page embeds a decorative 3D model from `sketchfab.com`. Branch PCs have no internet, so it shows "Loading 3D model" forever. It does not hold up the page | Remove the frame, or replace it with a local image |

## Double posting (fixed)

Posting routes: `process-withdraw-with-denomination`, `process-echeck-with-denomination`,
`process-deposit-with-denomination`, `process-transfer`, `approve-pending-transaction`.
All five now run under `withPostingLock` (`smart_branch_backend/utils/rms/postingLock.js`).
The route code itself was not changed.

| Situation | Before | Now |
|---|---|---|
| Same transaction submitted several times at once (double click, retry, two checkers) | Every request posted to FlexCube | One posts. The others get HTTP 409 "already being processed" |
| Submitted again after it finished | Refused by the status check | Same |
| FlexCube accepted the posting, then saving the result failed | Stayed "assigned"; the next attempt posted it again | Recorded in `unrecordedpostings`; every later attempt is refused with the FlexCube reference until someone resolves it (README, "A posting was accepted by FlexCube but not saved") |
| FlexCube refused the posting | Stays "assigned", can be retried | Same |

Tested with a stand-in FlexCube: 5 identical requests at once gave 5 postings before and 1 now
(4 and 1 for checker approvals).

Not covered:
- **Withdraw and e-check through their direct routes** could not be posted in the test (their
  limit check needs FlexCube's database). Their posting was tested through the checker's
  approval, and the lock was seen refusing duplicates on the direct routes.
- **A server crash between FlexCube's answer and the save.** Nothing is left to record it, and
  the lock expires after 10 minutes. Closing this needs FlexCube to refuse a repeated XREF, or
  a look-up in FlexCube by XREF before posting.
- **Other-bank transfers and air-ticket payments** have no FlexCube posting route (they are
  marked as posted by hand through `/transaction_posted`), so there is nothing to lock.

## Requests that are not finished on the day they are made (not changed — needs a decision)

The reference code (`Customer_Unique_Number`, 8 random digits made by the customer app) has no
expiry time of its own. A request simply stops being reachable at **midnight of the day it was
made** (server time), because these routes read today's requests only:

| Who | Route | After midnight |
|---|---|---|
| Customer app | `get_account_number_by_reference_number`, edit, delete | "Invalid or Expired Reference Number" |
| Teller | `transactions` (search by code), `get_assigned_to_me` | Not found / not listed |
| Admin, Authorizer | `get_assigned_transaction_per_brnach` (Reassignment) | Not listed |
| Authorizer | `get_posted_data` | Not listed |
| Auditor | `get_authorized_data` | Not listed |

Nothing changes the record. It keeps its last status for ever and is only visible in Branch
Record. The Branch Record statistics now count such requests as "Not served" and warn about
posted or authorized transactions left over from earlier days, but that is worked out when
the page is read; the stored status is still `assigned`, `posted` and so on.

| # | Problem | Suggested fix |
|---|---|---|
| E1 | An unserved request stays `requested` / `assigned` for ever. The `delayed` status exists but nothing sets it | Give each request an explicit `expires_at`; a job at end of day sets a final `expired` status with the time and reason. Never delete the record |
| E2 | The posting routes check the status only, not the date. A request from an earlier day can still be posted by calling the route with its id | Refuse to post when the request is expired |
| E3 | A transaction **posted to FlexCube** but not authorized the same day drops out of the Authorizer's list; the same for authorized but not audited. The money has moved, the control step is silently skipped | These must not expire. Keep them in the Authorizer / Auditor lists until done, oldest first, marked overdue |
| E4 | The code is unique per collection for all time and only 8 digits. As records accumulate, a new request will now and then collide with an old one and fail to save | Retry with a new code on a duplicate, or make the code unique per day |
| E5 | "Expired at midnight" follows the server clock, not the branch's business day | Decide the rule (end of business day is the usual one) and state it on the customer's SMS |

## Performance work that was deferred

### Needs FlexCube / DBA testing (SQL changes)

| # | Where | What | Why deferred |
|---|---|---|---|
| P1 | `Smart_Branch/app/api/transactions/route.ts`, mini statement | The closing-balance function runs for every entry in the account's history, then one row is kept. Select the row first, call the function once on it. Also move the from-date filter inside the inner query | Must be checked against real data with EXPLAIN PLAN; a wrong rewrite shows wrong balances |
| P2 | `Smart_Branch/app/api/account/verify/route.ts`, name search | `REGEXP_LIKE` over the whole account table, sorted before keeping 5 | Needs a cheaper prefilter or an Oracle Text index (DBA) |
| P3 | `smart_branch_backend/services/FlexcubeTransactionService.js`, till updates | Up to 13 separate FlexCube calls per posting, each on its own connection | Touches money posting; change and test together with B1 |

### Could change behaviour

| # | Where | What | Why deferred |
|---|---|---|---|
| P4 | Backend list endpoints (`get_posted_data`, `get_authorized_data`, `pending-checker-transactions`, …) | `.lean()` would avoid building full Mongoose documents | `lean` skips schema defaults on older documents, so some fields could disappear from responses |
| P5 | Same lists | Each row still carries the customer's drawn signature (base64) | Needs the detail panels changed to load it on open |
| P6 | Kiosk withdrawal request | About 6 FlexCube and 15 MongoDB calls one after another; several could run in parallel | Reordering changes which error message a customer sees first |
| P7 | Bulk authorize / bulk audit | One find + one FlexCube query + one update per row | Batch version must reproduce every skip reason exactly |
| P8 | `Smart_Branch`, OpenCV | OpenCV is loaded twice: `public/opencv.js` (only used as a "ready" signal) and the bundled `@techstark/opencv-js` (does the work). The first is now cached for a week, so it costs memory, not network | Removing it changes when signature verification considers itself ready; needs testing with real signatures |
| P9 | `Smart_Branch/app/page.tsx`, account list | Refetched whenever the selected account changes, though it is per customer | It may be what refreshes balances after a transaction |
| P10 | `smart_branch_backoffice/src/views/user/User.js` | Refetches the user list on every filter or sort change | The filters are also sent to the server; not clear the server ignores them |
| P11 | `smart_branch_backoffice` | No refresh-token flow: after 15 minutes the token expires and the user is sent to login | New functionality, not a fix |

### Follow-ups

- **HTTPS.** Over plain HTTP the browser's built-in crypto is unavailable, so the customer app
  sends every encrypted response back to the server to be decrypted (`/api/decrypt`). HTTPS
  removes that round trip and enables the webcam without browser flags.
- **Rate limit and header spoofing.** The customer app now forwards each kiosk's address to the
  backend, so kiosks no longer share one 100-requests-per-minute budget. That address comes
  from the `X-Forwarded-For` header, which a browser can set itself while the app is reached
  directly on port 3000. Putting a reverse proxy in front (the HTTPS step) closes this.
- **16 MB of unused images** in `smart_branch_backoffice/public` (bingo pictures). They only
  make the image larger.
- **`core-js`** is imported in full by the backoffice (about 70 KB compressed on every load).
  It can go once the oldest browser on the branch PCs is known.
