# ZSmart Branch — containerized production deployment

```
 DB SERVER  10.1.2.143                    APP SERVER  10.1.2.132
 ┌───────────────────────────┐            ┌──────────────────────────────────────────────┐
 │ smartbranch-mongo 8.0.34  │ 27017/tcp  │ smartbranch-frontend    :3000  Smart_Branch     │
 │   ZSmartBranch            │◄───────────┤ smartbranch-backoffice  :4000  backoffice (nginx)│
 │ nightly backup → /opt/... │ app server │ smartbranch-backend     :5000  API              │
 └───────────────────────────┘ only       └───────────────────┬──────────────────────────┘
                                                              │ Oracle (thick mode)
                                         FlexCube 10.1.1.149 ◄┘  (bank core — not containerized)
```

- **Smart_Branch** (customer-facing, Next.js) is called by the branch PCs' browsers. They call the API on :5000 directly.
- **smart_branch_backoffice** (teller / manager / admin, React + Vite) is served by nginx. Its
  browser calls go to `/api/...` on :4000, and nginx forwards them to the backend (`/api/api/login` → `backend:5000/api/login`),
  the same as the Vite proxy did before.
- **smart_branch_backend** (Express) is the only component that uses MongoDB.

Every container has `restart: always` and a healthcheck. A host-side watchdog restarts
containers that hang, and Docker starts at boot. See [Auto-restart](#auto-restart).

This folder is part of the **smart_branch_backend** repository (`smart_branch_backend/deploy`),
so cloning the backend brings the deployment with it.

| Folder | Used on | Contents |
|---|---|---|
| `db-server/` | 10.1.2.143 | `deploy.sh`, MongoDB compose file, first-start user creation, backup script |
| `app-server/` | 10.1.2.132 | `deploy.sh`, compose file for the three apps, env templates |
| `host/` | both | `setup-host.sh` (one-time host preparation, run by the deploy scripts), container watchdog |

The Dockerfiles live in the three repositories (`*/Dockerfile`, `*/.dockerignore`, and
`smart_branch_backoffice/docker/nginx.conf`).

## Quick start

All of the code and these files are on the branch `deploy/docker-production` of the three
repositories. Until that branch is merged, clone it by name as shown.

**DB server (10.1.2.143)**

```bash
sudo mkdir -p /opt/smartbranch && cd /opt/smartbranch
sudo git clone -b deploy/docker-production https://github.com/RobelBethelhem/smart_branch_backend.git
sudo bash smart_branch_backend/deploy/db-server/deploy.sh
```

It prints the MongoDB connection string for the app server. Details: [section 1](#1-db-server-1012143).

**App server (10.1.2.132)**

```bash
sudo mkdir -p /opt/smartbranch && cd /opt/smartbranch
sudo git clone -b deploy/docker-production https://github.com/RobelBethelhem/smart_branch_backend.git
cd smart_branch_backend/deploy/app-server
sudo bash deploy.sh                 # first run: creates .env and env/*.env, then stops
sudo nano .env env/backend.env env/frontend.env     # fill in (section 2)
sudo bash deploy.sh                 # clones the other two repos, builds, starts, waits until healthy
```

**Every later release:** `git push` from your PC, then on the app server `sudo bash deploy.sh`.
**Undo a release:** `sudo bash deploy.sh rollback`.

Moving from the current (Windows) system needs the extra steps in
[section 3](#3-cutover-from-the-current-deployment): stop the old apps, move the data, then start.

---

## 0. Before you start

**Servers.** Linux x86-64 with Docker Engine 24+, the compose plugin (`docker compose version`
must work) and `git`. Install Docker from its own repositories:
<https://docs.docker.com/engine/install/> (packages `docker-ce`, `docker-ce-cli`,
`containerd.io`, `docker-compose-plugin`).

Learned on the real servers (the DB server is Ubuntu 24.04, the app server Oracle Linux 10):
- **Oracle Linux / RHEL:** there is no `apt-get`. Install with `dnf` from Docker's CentOS
  repository (`sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo`,
  then the same five packages, then `sudo systemctl enable --now docker`). When the shell
  offers to install `podman-docker`, answer **N**: it only imitates Docker.
- **Check the clock before the first start:** `timedatectl` must show the right local time and
  the zone `Africa/Addis_Ababa`. The app server came with the zone New York and a clock three
  hours ahead. Requests expire at midnight by this clock. If `System clock synchronized` says
  `no`, have the server pointed at the bank's time server, or the clock drifts.
- **Ping is blocked** on the bank network; test internet access with
  `curl -I https://github.com` instead.

**Building needs internet** (GitHub, Docker Hub, npm, download.oracle.com, Google Fonts). If the
app server has no internet access, build on another machine and copy the images over. See
[Building without internet](#building-without-internet-on-the-servers).

**Layout on the app server.** `deploy.sh` creates it: clone the backend, the script clones the
other two next to it.

```
/opt/smartbranch/
├── smart_branch_backend/        ← clone this one; deploy/ is inside it
│   └── deploy/                  ← this folder
├── Smart_Branch/                ← cloned by deploy.sh
├── smart_branch_backoffice/     ← cloned by deploy.sh
└── data/backend-uploads/        ← uploaded files (created by the first deployment)
```

The DB server only needs the backend repository (for this folder).

**Ask the DBAs for 40 FlexCube sessions.** The backend and the customer-facing app each keep a
fixed pool of 20 open sessions (`FLEXCUBE_POOL_MAX` in `app-server/.env`), up from 10 + 4. If
FlexCube allows fewer for this user, lower the number before starting, or the apps cannot
open their pools.

**Find out about the current system** (needed for the cutover in step 3). The apps in use
today appear to run on Windows under PM2.

```bash
pm2 list                                   # the old apps and how they are started
netstat -ano | findstr ":3000 :4000 :5000 :27017"     # Windows; on Linux: ss -ltnp
mongosh --quiet --eval "db.adminCommand({listDatabases:1}).databases.map(d=>d.name)"
```

If the database name is not `ZSmartBranch`: run `sudo bash host/setup-host.sh db` first, set the
real name as `SMARTBRANCH_DB_NAME` in `db-server/.env`, and only then run `db-server/deploy.sh`.
The name is fixed when MongoDB starts for the first time.

---

## 1. DB server (10.1.2.143)

```bash
sudo bash /opt/smartbranch/smart_branch_backend/deploy/db-server/deploy.sh
```

It prepares the server (through `host/setup-host.sh db`), starts MongoDB and waits until it is
healthy. The preparation:
- checks the CPU has AVX, which MongoDB 5+ requires;
- enables Docker at boot and installs the watchdog;
- creates `/opt/smartbranch/mongo/data` and `/opt/smartbranch/backups/mongo`;
- generates `db-server/.env` with random passwords (permissions 600) on the first run;
- installs the nightly backup timer (01:30, keeps 14 days);
- opens port 27017 to 10.1.2.132 only, if ufw or firewalld is active;
- prints the backend's MongoDB connection string.

At the end you should see:

```
[init] created smartbranch_app with readWrite on ZSmartBranch
==> MongoDB is running and healthy.
```

The script is safe to run again; `sudo bash deploy.sh status` shows the container.

The user is created **only on the first start** (empty data directory). Editing the password in
`.env` later does not change it in MongoDB. See [Change the database password](#change-the-database-password).

---

## 2. App server (10.1.2.132)

```bash
cd /opt/smartbranch/smart_branch_backend/deploy/app-server
sudo bash deploy.sh                 # first run: creates the three config files and stops
sudo nano .env env/backend.env env/frontend.env
```

What goes where:

| File | Values |
|---|---|
| `.env` | Compiled into the browser code: `NEXT_PUBLIC_API_URL`, `FINGERPRINT_WS_URL`, `NEXT_PUBLIC_RESPONSE_ENCRYPTION_KEY` (from the current `Smart_Branch/.env.local`). `IMAGE_TAG` is managed by `deploy.sh`. |
| `env/backend.env` | `DB=` from step 1, then FlexCube, JWT keys, encryption keys, SMS **copied from the current production backend `.env`**. |
| `env/frontend.env` | FlexCube credentials and `RESPONSE_ENCRYPTION_KEY` from the current `Smart_Branch/.env.local`. |

The backoffice has no settings file. It only serves files and forwards `/api` to the backend.
These three files are never committed (`deploy/.gitignore`); `git pull` leaves them alone.

⚠ **Reuse the existing `ACCOUNT_ENCRYPTION_KEY` / `REQUEST_ENCRYPTION_KEY`.** Data already
encrypted with them cannot be read with new keys.

Then deploy. `deploy.sh` refuses to start while a required setting is still empty and lists
which ones.

| Command | What it does |
|---|---|
| `sudo bash deploy.sh` | Pulls the three repos (clones the two missing ones), builds, starts, waits until healthy. On the first deployment it also prepares the host: Docker at boot, the watchdog, the uploads folder, and a check that MongoDB and FlexCube are reachable |
| `sudo bash deploy.sh build` | Pulls and builds only. Nothing is started or stopped. Use it before a maintenance window |
| `sudo bash deploy.sh --no-build` | Starts the images that `IMAGE_TAG` in `.env` names (after `build`, or after `docker load`) |
| `sudo bash deploy.sh --no-pull` | Builds and starts the code that is on disk, without git |
| `sudo bash deploy.sh rollback` | Returns to the release that ran before the last deployment |
| `sudo bash deploy.sh status` | Shows the containers and their health |

The first build takes roughly 5–15 minutes. If a build fails, the script tries once more and
then stops without touching the running containers.

If the old apps still hold ports 3000/4000/5000 on this server, use `deploy.sh build` now and
start in step 3.

---

## 3. Cutover from the current deployment

Plan a short maintenance window. Nothing below deletes the old system, so you can roll back.

1. **Stop the old apps** so nothing writes to the old database: `pm2 stop all`. Keep their
   definitions (no `pm2 delete`): they are the rollback. **Also disable the PM2 start at boot**
   (the PM2 service / scheduled task / `pm2 unstartup` on Linux). Otherwise, after a reboot they
   come back and write to the old database.

2. **Dump the old MongoDB** on the machine where it runs.
   - With MongoDB Database Tools (Windows or Linux):
     ```bash
     mongodump --uri mongodb://127.0.0.1:27017 --db ZSmartBranch --archive=smartbranch-migration.archive.gz --gzip
     ```
   - Or, on a Linux host with Docker:
     ```bash
     sudo docker run --rm --network host -v /tmp:/out mongo:8.0.34 mongodump \
       --uri mongodb://127.0.0.1:27017 --db ZSmartBranch --archive=/out/smartbranch-migration.archive.gz --gzip
     ```

   Copy the file to the DB server's `/tmp/` (scp / WinSCP). If the old MongoDB requires a login,
   put it in the URI (`mongodb://user:pass@127.0.0.1:27017/?authSource=admin`).

3. **Restore on the DB server.** `--drop` makes a retry safe:
   ```bash
   sudo docker exec -i smartbranch-mongo sh -c 'mongorestore --host 127.0.0.1 \
     --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" \
     --authenticationDatabase admin --archive --gzip --drop --nsInclude="ZSmartBranch.*"' \
     < /tmp/smartbranch-migration.archive.gz
   ```

4. **Copy uploaded files.** Copy the old backend's `uploads` folder (e.g. `smart_branch_backend\uploads` on
   the old server) into `/opt/smartbranch/data/backend-uploads/` on the app server, then:
   ```bash
   sudo chown -R 1000:1000 /opt/smartbranch/data/backend-uploads
   ```

5. **Start the containers:**
   ```bash
   cd /opt/smartbranch/smart_branch_backend/deploy/app-server
   sudo bash deploy.sh --no-build  # after `deploy.sh build`; or plain `sudo bash deploy.sh` to build now
   ```
   It waits until all three are healthy and prints their status.

6. **Smoke test:**
   ```bash
   curl -s  http://10.1.2.132:5000/healthz          # {"status":"ok","mongo":"connected"}
   curl -s  http://10.1.2.132:4000/api/healthz      # same answer, through the backoffice proxy
   curl -sI http://10.1.2.132:3000/ | head -1       # HTTP/1.1 200 OK
   curl -sI http://10.1.2.132:4000/ | head -1       # HTTP/1.1 200 OK
   ```
   Then, from a branch PC:
   - log in to the backoffice as a teller and as an admin;
   - look up an account in Smart Branch (FlexCube);
   - submit a test deposit and post it from the teller queue.

   These could not be tested without FlexCube, so check each once after go-live:
   - **Authorize, Audit and Reassignment screens:** open a row. The customer photo and the
     signature comparison must appear a moment after the panel opens (they now load on open).
   - **Smart Branch login** by account number, by name, and by phone, with OTP and with face.
   - **Signature check** on a withdrawal (the first one after a page load takes a little longer).
   - **Mini statement:** opening balance and rows for "month" and for a custom range.
   - **Transfer:** the beneficiary's name appears after typing the account number.
   - **SMS:** the customer receives the queue-number SMS after a deposit, and the OTP SMS.
   - **Pending Checker Approval:** an authorizer sees their own branch's items only (intended).
   - **Double submit:** post a small deposit and click the post button twice quickly. Exactly
     one FlexCube reference must result; the second click shows "already being processed".
   - **Idle timeout:** leave Smart Branch untouched for 100 seconds. The promo video must
     appear, and a touch must bring back the welcome screen.

   The old system ran on Windows, which ignores upper/lower case in file names and Linux does not.
   One such bug was found and fixed during testing (`models/rms/User.js`), so watch the logs
   during the first days: `sudo docker compose logs -f`.

**Rollback:** `sudo docker compose down` on the app server, then start the old apps again
(`pm2 start all`). They still point at the old MongoDB, which still holds
the data as of step 1. Anything written while the new system ran exists only in the new database.

---

## Auto-restart

| Situation | What brings the app back |
|---|---|
| The app crashes or is killed (incl. out-of-memory) | `restart: always`: Docker restarts it within seconds |
| Docker daemon restarts, or the server reboots | Docker starts at boot (`setup-host.sh`), then `restart: always` starts every container |
| The app hangs (running, but its healthcheck fails 3× in a row) | `smartbranch-watchdog.timer` checks every minute and restarts it |
| The backend is recreated (new release) | nginx looks the backend up again within 10 s; no backoffice restart needed |
| An operator runs `docker compose stop` / `down` | Nothing: a deliberate stop is respected |

MongoDB is restarted on crash and at boot, but not by the watchdog: restarting a database that is
only slow under load makes things worse.

**Check it after go-live:**

```bash
# crash: kill the app inside the container → back within ~10 s, RestartCount goes up
sudo docker exec smartbranch-backend sh -c 'kill -9 -1'
sleep 10; sudo docker ps --filter name=smartbranch-backend --format '{{.Names}}  {{.Status}}'
sudo docker inspect -f '{{.RestartCount}}' smartbranch-backend

# reboot: everything is Up (healthy) again after boot
sudo reboot        # … then: cd /opt/smartbranch/smart_branch_backend/deploy/app-server && sudo docker compose ps

# watchdog activity
systemctl list-timers smartbranch-watchdog.timer
journalctl -u smartbranch-watchdog --since today
```

---

## Capacity settings (500+ users)

| Setting | Where | Value | What it does |
|---|---|---|---|
| `FLEXCUBE_POOL_MAX` | `app-server/.env` | 20 | FlexCube sessions each of the backend and the customer app keeps open |
| `UV_THREADPOOL_SIZE` | the two `Dockerfile`s | 24 / 28 | How many FlexCube calls can run at once. Must stay above the pool size |
| `FLEXCUBE_DEBUG` | `env/backend.env` | off | Step-by-step posting logs. Slows every request; only for troubleshooting |
| Rate limit | backend code | 100 requests per minute per PC | Each staff PC and each kiosk has its own budget |

The first start after this release builds new MongoDB indexes in the background. On a large
database that takes a few minutes; the apps work meanwhile.

Bugs and slower spots that were found but deliberately not changed are listed in
[KNOWN-ISSUES.md](KNOWN-ISSUES.md).

---

## Day-to-day operations

Run `docker compose` in the folder that holds the compose file:
`/opt/smartbranch/smart_branch_backend/deploy/app-server` or `.../deploy/db-server`.

```bash
sudo docker compose ps                            # status and health
sudo docker compose logs -f --tail=200 backend    # logs (rotated: 10 × 20 MB per container)
sudo docker compose restart backoffice            # restart one service
sudo docker stats                                 # CPU / memory per container
```

**Change runtime configuration** (`env/*.env`): edit, then `sudo docker compose up -d`. Only the
changed containers are recreated.
**Change a value compiled into the browser code** (`NEXT_PUBLIC_*`, `FINGERPRINT_WS_URL` in `.env`):
rebuild, `sudo docker compose build frontend backoffice && sudo docker compose up -d`.

### Release a new version

Push the changes to GitHub, then on the app server:

```bash
cd /opt/smartbranch/smart_branch_backend/deploy/app-server
sudo bash deploy.sh
```

It pulls the three repositories, builds them under a new tag (date, time and commit), starts
them and waits until they are healthy. Only containers whose image changed are recreated.
The servers follow whatever branch the backend is on (`git branch --show-current`). After
`deploy/docker-production` is merged, switch them once with `sudo git checkout master` (backend
and backoffice) and `sudo git checkout main` (Smart_Branch).

### Roll back a release

`sudo bash deploy.sh rollback` returns to the release that ran before the last deployment
(running it again goes forward again). For an older one, put its tag in `.env` as `IMAGE_TAG`
and run `sudo bash deploy.sh --no-build`. Old images stay on the server until you remove them. List them with `sudo docker image ls 'smartbranch/*'`. Keep
the last two or three releases and remove older ones with `sudo docker image rm smartbranch/<app>:<tag>`.

### Backups

```bash
ls -lh /opt/smartbranch/backups/mongo                            # nightly archives
systemctl list-timers smartbranch-mongo-backup.timer             # next run
sudo systemctl start smartbranch-mongo-backup                    # back up now
journalctl -u smartbranch-mongo-backup -n 20
```

Copy the archives off the DB server as well (backup share, tape). A backup that only exists on
the DB server is lost with it.

### Restore a backup

Restores the application database; MongoDB's own user accounts are left alone:

```bash
sudo docker exec -i smartbranch-mongo sh -c 'mongorestore --host 127.0.0.1 \
  --username "$MONGO_INITDB_ROOT_USERNAME" --password "$MONGO_INITDB_ROOT_PASSWORD" \
  --authenticationDatabase admin --archive --gzip --drop --nsInclude="ZSmartBranch.*"' \
  < /opt/smartbranch/backups/mongo/mongo-YYYYMMDD-HHMMSS.archive.gz
```

### A posting was accepted by FlexCube but not saved

Rare, but it needs a person. A teller or checker sees:
*"This transaction was already posted to FlexCube (reference …) but the result could not be
saved. Do NOT post it again."* FlexCube moved the money, then saving the new status failed
(database unreachable, or the record is missing a required field). The transaction still shows
as assigned or pending, and the system refuses to post it again.

1. Find the cause in the backend log: `sudo docker compose logs backend | grep -A3 POSTING_LOCK`.
2. Confirm in FlexCube that the reference exists for that account and amount.
3. In the MongoDB shell (below), list the open cases and correct the transaction:
   ```js
   use ZSmartBranch
   db.unrecordedpostings.find()
   // example for a deposit; use withdraws / echecks / transfers for the other kinds
   db.deposits.updateOne({ _id: ObjectId("<transaction id>") },
     { $set: { status: "posted", trn_ref_no: "<FlexCube reference>", posted_date: new Date() } })
   db.unrecordedpostings.deleteOne({ _id: "Deposit:<transaction id>" })
   ```
   If FlexCube does NOT have the reference after all, only delete the `unrecordedpostings`
   record; the transaction can then be posted normally.

### FlexCube requests that hung on first use

Found on the new servers (November 2026), fixed in `lib/db.js` (backend) and `lib/db.ts`
(customer app). The first customer after a start waited on "loading" for ever; after a page
refresh it worked; later it came back. Sometimes every FlexCube request failed after exactly
60 seconds until the app was restarted.

Cause: a mistake in the code that prepares a new FlexCube connection (`initSession`, in the
code since July 2026). The Oracle driver waits for that step to report "done", and it never
did. So the first request on every new pooled connection never returned, and the pool counted
that connection as in use for ever. After as many such requests as the pool has connections,
every FlexCube call waited the pool's 60 seconds and failed. A new connection appears at
start, when two requests overlap, and when FlexCube or the network closed an old one.

Measured before the fix: first account look-up no answer after 180 s, the same look-up again
0.01 s; backend exactly 60 s; a new FlexCube log-on 0.04 s.

Check it with `sudo bash flexcube-check.sh` in `app-server/`, right after a start: every line
must take well under a second, the first one included.

A log line `[FLEXCUBE] waited N ms for a pooled connection (x of y in use)` means a request
could not get a FlexCube connection quickly. It does not mean a slow query.

**Keep-alive (a precaution, not part of that fix).** Both apps keep their FlexCube connections
open while idle, and a firewall sits between the app server and FlexCube. Both apps therefore
add `expire_time=1` to the connection string (`withKeepAlive`): a probe every minute on idle
connections. `FLEXCUBE_EXPIRE_TIME` in `env/backend.env` and `env/frontend.env` changes the
minutes; `0` switches it off. Whether this network really drops idle connections was not
established. To find out, leave the apps untouched for 30 minutes and run the check again.

### Customer 360

When a customer's request gets a teller, the branch sees a notification "… has arrived" in
the backoffice. Clicking it opens the customer's page: who they are, key figures, scores,
balance trend, cash flow, channel usage.

**When the notification is made** (`utils/rms/customer360/arrivals.js`)

| Situation | Notification |
|---|---|
| The customer asked for a teller and the system chose one | Yes, at once |
| A teller took a waiting request herself (Assigned To Me) | Yes, at that moment |
| The customer only wanted a code (no teller yet) | No, until a teller takes the request |
| A request is given to another teller (Reassignment) | No new one; the existing one moves to that teller |

**Who sees it.** The branch's Admin always. Other roles when the Admin has ticked them under
Admin → Customer 360 Access (Authorizer is ticked to begin with). Tellers and makers, when
ticked, see only the customers assigned to them. Other branches never see it.

**How it arrives.** The backoffice asks the server every 8 seconds; a card slides in at the top
right, the bell shows a count, a short sound plays and the count appears in the tab's title.
The browsers' own push service needs the internet and system notifications need HTTPS, and
the branches have neither, so the page has to be open in a tab. Over HTTPS the bell menu also
offers "Turn on desktop notifications". A tab in the background can be up to a minute late,
because browsers slow down hidden tabs.

**What the page is made of.** Sections, managed by the Super Admin under Customer 360
Sections. Every section has demo rows (invented, marked "Demo data" on the page) and a query.

| To do this | Do this |
|---|---|
| Show a customer's real data in a section | Edit the section, adjust the query, type a customer number and press **Run**, compare the result with FlexCube, then choose "Live: run the query" and save |
| Add a section | "Add a section", choose the kind (figures, scores, trend chart, in/out chart, share chart, list of details, text, highlights, table). The sample query and sample rows of that kind are loaded as a start |
| Take a section off the page | Switch off "Shown" |
| See the whole page for a customer | "Preview the page" |
| See who looked at which customer, who revealed hidden details, who changed a query | "Activity log" (collection `customer360audits`) |

Rules for a section query (`utils/rms/customer360/sqlGuard.js`):
- one `SELECT` (or `WITH … SELECT`), no semicolon, nothing that changes data;
- the customer comes in through `:cif`, `:account_number` and `:branch_code`, which the server
  fills in. A query must use `:cif` or `:account_number`;
- it returns the columns of its kind of section (the editor lists them, e.g. `LABEL`, `VALUE`);
- it runs in a read-only transaction, with a time limit of 15 s and at most 200 rows;
- a failing section shows "could not be loaded" on the page; the database's message is only
  in the Super Admin's preview and in the backend log (`[CUSTOMER360] section "…" failed`).

⚠ **The sample queries have not been run against FlexCube.** They use the tables this system
already reads, but the column names must be checked, section by section, with Run. The
"Customer scores" sample points at a table that does not exist: FlexCube has no such scores.

⚠ **A Super Admin can read any FlexCube data this way** (as the FlexCube user of the backend).
Give that role to very few people, and give the FlexCube user SELECT rights only.

Details marked sensitive (phone, e-mail, ID number) reach the browser masked. "Reveal · logged"
fetches the real values and records who asked.

Settings in `env/backend.env`, both optional: `CUSTOMER360_QUERY_TIMEOUT_MS` (default 15000),
`CUSTOMER360_CACHE_SECONDS` (default 120: how long a live result is reused when several
people open the same customer; 0 switches it off).

To try it without a customer: Customer 360 → "Simulate an arrival" (Admin). The arrival is
marked "Simulated".

### Requests expire at the end of the day

A customer's request and its reference code are valid until **midnight of the day it was made**
(server time, Africa/Addis_Ababa). The rule is in `utils/rms/requestExpiry.js`.

| Request at midnight | What happens |
|---|---|
| Not posted to FlexCube yet (requested, assigned, waiting for a checker) | Status becomes `expired`. It can no longer be assigned, posted or approved. The customer makes a new request. The record is kept, with `expired_at`, `expiry_reason` and `status_before_expiry` |
| Posted, not authorized (deposit, withdraw, e-cheque, transfer, other-bank transfer) | Never expires. Stays in the Authorizer's list, marked "Overdue" |
| Posted or authorized, not audited | Never expires. Stays in the Auditor's list, marked "Overdue" |

- The customer is told: the SMS with the code says "This code is valid only for today
  (10 Nov 2026)."
- The backend marks expired requests when it starts and every 10 minutes after that. The log
  line is `[REQUEST_EXPIRY] N request(s) ... are now expired`. The posting routes also check the
  date themselves, so nothing can be posted in the minutes before the next run.
- **The first start after this release closes every old unserved request in the database in
  one go.** That is expected, and it only touches requests that never moved money.
- The Authorizer's and Auditor's lists go back `CARRY_OVER_DAYS` days (default 7, set in
  `env/backend.env`). Older unfinished items are still counted in the warning at the top of
  Branch Record → Statistics.
- To see what expired: Branch Record shows the status "Expired" and counts them as "Not
  served". In the MongoDB shell: `db.deposits.find({ status: "expired" }).sort({ expired_at: -1 })`.
- To undo one expiry by hand (for example the server clock was wrong), set the status back
  from the saved one:
  ```js
  db.deposits.updateOne({ Customer_Unique_Number: "12345678" },
    [{ $set: { status: "$status_before_expiry" } }, { $unset: ["expired_at", "expiry_reason", "status_before_expiry"] }])
  ```
  It expires again at the next run unless its `request_date` is today.

### MongoDB shell

```bash
sudo docker exec -it smartbranch-mongo sh -c \
  'mongosh -u "$MONGO_INITDB_ROOT_USERNAME" -p "$MONGO_INITDB_ROOT_PASSWORD" --authenticationDatabase admin'
```

### Change the database password

In the MongoDB shell: `db.getSiblingDB('admin').changeUserPassword('smartbranch_app', '<new>')`
(use letters and digits only). Then update it in `db-server/.env` (for the record) and in the app server's
`env/backend.env`, then run `sudo docker compose up -d` on the app server.

---

## Building without internet on the servers

⚠ **The `2026.11.10-1` archives are out of date.** They were built before the Branch Record
changes, the end-of-day expiry and the e-cheque fixes. Do not go live with them: build on the
server (`deploy.sh`), or build and export a new set as described at the end of this section.

**Ready-made images for release `2026.11.10-1`** were exported on the build PC
(`D:\Full Smart Branch\images`; they are too large for git):
`smartbranch-2026.11.10-1.tar` (the three apps, for the app server) and `mongo-8.0.34.tar` (for
the DB server), with `SHA256SUMS`. Copy them over, check them, load them:

```bash
sha256sum -c SHA256SUMS
sudo docker load -i smartbranch-2026.11.10-1.tar     # app server
sudo docker load -i mongo-8.0.34.tar                 # DB server
```

Then set `IMAGE_TAG=2026.11.10-1` in `app-server/.env` and run `sudo bash deploy.sh --no-build`. They were
built with `NEXT_PUBLIC_API_URL=http://10.1.2.132:5000`, the fingerprint address
`ws://10.1.2.132:8089`, and the `NEXT_PUBLIC_RESPONSE_ENCRYPTION_KEY` from
`Smart_Branch/.env.local` in git. If production uses different values, rebuild the frontend.

To build a later release yourself:

On any x86-64 machine with Docker and internet access (e.g. a workstation with Docker Desktop),
with the production `app-server/.env` in place:

```bash
cd deploy/app-server
docker compose build
docker save -o smartbranch-<TAG>.tar smartbranch/backend:<TAG> smartbranch/frontend:<TAG> smartbranch/backoffice:<TAG>
docker pull mongo:8.0.34 && docker save -o mongo-8.0.34.tar mongo:8.0.34
```

Copy the `.tar` files over. Then `sudo docker load -i <file>.tar` on the target server, and
`sudo docker compose up -d --no-build`. Values compiled into the browser code are fixed at build
time, so build with the production `.env`, not a test one.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `bind source path does not exist: …/backend-uploads` | Run `sudo bash ../host/setup-host.sh app` (the first `deploy.sh` does this) |
| `deploy.sh`: "git pull failed" | Someone edited files on the server. See them with `sudo git -C <repo> status`; undo them, or deploy what is there with `--no-pull` |
| `deploy.sh` asks for a GitHub user name | The repositories are private. Use a GitHub access token as the password, or set up a deploy key |
| Backoffice build stops with `exit code: 135` or `139`, or hangs at "transforming…" | Seen about one time in five on Docker Desktop for Windows, where the Docker engine itself was unstable. Run the build again. If it ever happens on the Linux server, note the exit code and report it |
| "This transaction is already being processed" | Someone (or a second click) is posting the same transaction. Wait and refresh; it protects against double posting |
| `port is already allocated` | An old app still holds the port: `sudo ss -ltnp \| grep :5000` |
| `failed to bind host port 0.0.0.0:5000/tcp: address already in use` | Another program holds the port on `127.0.0.1` only (on the app server: Nutanix Guest Tools). Do not stop it. Set `BACKEND_PORT=10.1.2.132:5000` in `.env` (see `.env.example`), then `sudo bash deploy.sh --no-build` |
| The first customer after a start waits for ever, a refresh helps; or every FlexCube request fails after 60 s | See [FlexCube requests that hung on first use](#flexcube-requests-that-hung-on-first-use). Fixed in the code; if it returns, look for `[FLEXCUBE] waited` in the logs |
| Mongo container keeps restarting, log says `Illegal instruction` | The CPU lacks AVX (see step 1) |
| Backend log: `MongoDB error … Authentication failed` | Wrong password, missing `?authSource=admin`, or Windows line endings in the env file. `setup-host.sh` fixes line endings; re-run it |
| Backend log: `Cannot find module …` | A file-name case mismatch (works on Windows, not Linux). Rename the file to the case used in the import |
| Backoffice shows errors, `/api/...` answers `502 Bad Gateway` | The backend container is down or restarting: `sudo docker compose ps`, `sudo docker compose logs backend` |
| `429 Too many requests` | Backend rate limit: 100 API requests per minute per PC (per container for server-side calls) |
| Backend/frontend: `DPI-1047` / FlexCube errors | Test the route from the container: `sudo docker exec smartbranch-backend node -e "require('net').connect(1521,'10.1.1.149').on('connect',()=>{console.log('ok');process.exit()}).on('error',e=>{console.log(e.message);process.exit(1)})"` |
| Webcam never starts in Smart Branch | Browsers only allow the camera over HTTPS or on localhost. This is unchanged from before the move: use the Chrome flag shown in the app, or add HTTPS |
| Names like `api.zemenbank.com` don't resolve in a container | Containers use the server's DNS. If the server relies on `/etc/hosts`, add `extra_hosts:` to the service |
| Something on 172.28.10.0/24 became unreachable | Docker network overlap: change `APP_SUBNET` in `.env`, then `sudo docker compose down && sudo docker compose up -d` |

---

## Known limitations / open items

1. **Fingerprint matching does not work on Linux.** `/biometric/authenticate` and `/biometric/verify`
   run `ZKCapture.exe`, a Windows-only ZKTeco SDK program. In the Linux container these
   routes answer "not matched" (no crash). Fixing it needs either the ZKFinger SDK for Linux or a
   small matching service on a Windows host. The capture service (port 8089, used for
   registration) runs on the Windows PC with the USB scanner and is not affected.
2. **Plain HTTP.** All three apps keep their current HTTP ports. HTTPS (e.g. a TLS reverse proxy)
   would enable the webcam without browser flags. Recommended next step.
3. **No lockfile in smart_branch_backoffice.** Its `.gitignore` excludes `package-lock.json`, so
   each build picks up the newest dependency versions `package.json` allows. Commit a lockfile
   for repeatable builds; the Dockerfile then uses `npm ci` automatically.
4. **Deferred performance work and known bugs** are in [KNOWN-ISSUES.md](KNOWN-ISSUES.md).
   Double posting to FlexCube is fixed; that file says what the fix covers and what it does not.
5. **Secrets in git history.** `Smart_Branch/.env.local` and `smart_branch_backend/.env` are tracked,
   and a default SMS password is hard-coded in `routes/rms/ZSmartBrannchRequests.js`. Rotate those
   credentials. The new deployment keeps its secrets only in the servers' env files (mode 600).
6. **Node.js 22** reaches end-of-life in April 2027. Plan the move to Node 24.
