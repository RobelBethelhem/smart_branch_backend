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
| B9 | `smart_branch_backoffice`: Authorize, Audit and Branch Record screens | ~~They showed "... successfully!" for any HTTP 200, also when the server had skipped every selected transaction.~~ **Fixed**: the message says how many were done, how many were not, and the server's reason (`src/utils/bulkActionResult.js`) | — |
| B10 | `ZSmartBrannchRequests.js` `/transaction_authorized` | The "cannot authorize transactions you posted" check compares `posted_by` with `user.name`. The user record has no `name` field (the name is in `user`), so the check never stops anyone. FlexCube's own maker/checker rule is what actually prevents it | Compare with `user.user` |
| B11 | `ZSmartBrannchRequests.js` `/transaction_audited` | The "cannot audit transactions you authorized" check reads `authorized_by`. The field is called `authorizer_name`, so the check never stops anyone | Read `authorizer_name` |

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

## Requests that are not completed on the day they are made (end-of-day expiry)

Decision (November 2026): a request and its reference code are valid until the **end of the
day** it was made. Implemented in `utils/rms/requestExpiry.js`; how to operate it is in the
README ("Requests expire at the end of the day").

| # | Problem found | State |
|---|---|---|
| E1 | An unserved request stayed `requested` / `assigned` for ever and was only visible in Branch Record | **Fixed.** It gets the final status `expired` (with time, reason and the status it had) at the end of the day. Nothing is deleted |
| E2 | The posting routes checked the status only, not the date, so a request from an earlier day could still be posted by calling the route with its id | **Fixed.** The five FlexCube posting routes, `/transaction_posted` and `/assigned_to_me` refuse an expired request |
| E3 | A transaction posted to FlexCube but not authorized the same day dropped out of the Authorizer's list (same for the Auditor's list): the money had moved and the control step was silently skipped | **Fixed.** Posted work never expires and stays in those lists, marked "Overdue", for `CARRY_OVER_DAYS` days (default 7); older items are counted in Branch Record's warning |
| E4 | ~~The reference code is 8 random digits made by the customer app and can collide.~~ **That was wrong.** The server makes the code itself (`generateUniqueCustomerNumber`): 10 letters and digits, checked against all six collections before use. The 8-digit number the customer app makes is ignored by the server | Nothing to fix |
| E5 | The customer's SMS did not say how long the code is valid | **Fixed.** The five request SMS texts (deposit, withdraw, e-cheque, transfer, other-bank transfer) carry the line "This code is valid only for today (10 Nov 2026)." |
| E6 | E-cheques were in neither the Authorizer's nor the Auditor's list, and the authorize and audit steps did not accept them, so a posted e-cheque stayed `posted` for ever | **Fixed.** An e-cheque is posted exactly like a withdrawal, and now follows the same steps: both lists, `/transaction_authorized` and `/transaction_audited` |
| E7 | Places that treated e-cheques differently from withdrawals | **Fixed:** (1) `assignTellerBySystem` now counts a teller's e-cheques of today when it picks the least busy teller. (2) The customer app can look up, edit and cancel an e-cheque request by its code (`get_account_number_by_reference_number`, `edit_smart_branch_request`, `delete_smart_branch_request`, and the form in `Smart_Branch/app/page.tsx`) |
| E8 | Editing or cancelling a request by its code had no status check: on the day it was made, a request that was already posted could still have its amount changed, or be deleted, by anyone who had the code. The amount was stored without any check (the posting step reads it with `parseFloat`, so "1,000" would have been posted as 1) | **Fixed** for all five kinds of request. A request can be changed or cancelled only while it is pending (`requested`) or assigned; otherwise the customer is told to see the teller. The amount must be a plain positive number |
| E9 | `delete_smart_branch_request` named `OtherBankTransfer`, which does not exist, so cancelling an other-bank transfer always failed with a server error | **Fixed** |
| E10 | The withdrawal and e-cheque success screens showed a number made up in the browser as "Reference Number"; the deposit screen showed the queue number under that label; the two transfer screens showed the unique code | **Changed** (decision, November 2026): all five success screens show "Queue Number". The unique code is not shown on the tablet; it goes to the customer's phone by SMS, and the screen says so |

A request waiting for a checker (`pending_checker`) expires like the others: nothing has been
posted to FlexCube until the checker approves, and the customer is no longer at the counter the
next day. To keep such requests alive instead, remove `pending_checker` from
`EXPIRING_STATUSES` in `utils/rms/requestExpiry.js`, in `utils/rms/branchStats.js` and in the
backoffice's `Branch_Record/recordFormat.js`.

"End of the day" is midnight on the server clock, not the branch's closing time.

## Found while deploying on the real servers (November 2026)

| # | Problem | State |
|---|---|---|
| S1 | The first request on every new pooled FlexCube connection never returned, and the pool counted that connection as in use for ever. Customers saw "loading" until they refreshed; after as many such requests as the pool has connections, every FlexCube call failed after 60 s until a restart. Cause: `initSession` in `lib/db.js` and `lib/db.ts` (in the code since July 2026) did not tell the Oracle driver that it had finished. The system in production has the same code, so it has the same fault | **Fixed** in both apps (README, "FlexCube requests that hung on first use"). My first diagnosis, idle connections dropped by the network, was wrong. A keep-alive on idle connections stays in as a precaution |
| S2 | On the app server, port 5000 is held on `127.0.0.1` by Nutanix Guest Tools, so the backend could not start | **Handled** by a setting: `BACKEND_PORT=10.1.2.132:5000` in `app-server/.env` |
| S3 | The app server's clock was three hours ahead and its zone was New York | Set by hand. **Open:** the clock is not synchronised (`timedatectl` says `System clock synchronized: no`). Check the DB server as well |
| S4 | The DB server has no host firewall, and both servers are in the same subnet, so the network firewall does not see the traffic between them | **Open:** allow port 27017 from 10.1.2.132 only, on the DB server itself (ufw) |
| S5 | When a FlexCube query fails, the customer app answers "Account not found" (404), the same as for an account that does not exist | **Open**, behaviour unchanged: a customer cannot tell "not found" from "FlexCube did not answer". The backend log shows the real error |

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
