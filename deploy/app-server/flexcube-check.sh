#!/usr/bin/env bash
# Times a FlexCube look-up through each app, and a new FlexCube log-on.
#
#   sudo bash flexcube-check.sh
#
# Use it right after a deployment, and again after the apps were left untouched for 30 minutes
# (README, "FlexCube requests that hung on first use"). Every line should take well under a
# second, the first one included. It uses an account and a phone number that do not exist, so
# "HTTP 404" is the expected answer, no SMS is sent and nothing is written. Only the seconds
# matter.
#
# The backend allows 5 of these phone look-ups per 15 minutes from one address; after that
# line 3 answers "HTTP 429" at once, which says nothing about FlexCube.
set -u
cd "$(dirname "$0")"

env_value() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1 | tr -d '\r'; }

api=$(env_value .env NEXT_PUBLIC_API_URL)
api=${api:-http://127.0.0.1:5000}
host=${api#*://}; host=${host%%[:/]*}
frontend_port=$(env_value .env FRONTEND_PORT); frontend_port=${frontend_port##*:}
frontend="http://$host:${frontend_port:-3000}/api/account/verify"
backend="$api/api/zsmart_branch_requests/generate-otp"

timed() {
  curl -s -o /dev/null --max-time 180 -w '%{time_total}s  HTTP %{http_code}\n' \
    -X POST -H 'Content-Type: application/json' -d "$2" "$1"
}

date
echo "1. customer app, look-up by account (twice)        $frontend"
timed "$frontend" '{"accountNumber":"0000000000000000","includeImages":false}'
timed "$frontend" '{"accountNumber":"0000000000000000","includeImages":false}'
echo "2. customer app, look-up by name and phone (twice)"
timed "$frontend" '{"firstName":"Zzzz","phoneNumber":"+251900000000","includeImages":false}'
timed "$frontend" '{"firstName":"Zzzz","phoneNumber":"+251900000000","includeImages":false}'
echo "3. backend, phone look-up (once)                   $backend"
timed "$backend" '{"account_number":"0000000000000000"}'
echo "4. new FlexCube log-on from the backend container (three times)"
docker exec smartbranch-backend node -e '
const o = require("oracledb");
o.initOracleClient({ libDir: process.env.ORACLE_CLIENT_PATH });
(async () => {
  for (let i = 1; i <= 3; i++) {
    const a = Date.now();
    const c = await o.getConnection({ user: process.env.FLEXCUBE_DB_USER, password: process.env.FLEXCUBE_DB_PASSWORD, connectString: process.env.FLEXCUBE_DB_CONNECTION_STRING });
    const b = Date.now();
    await c.execute("select 1 from dual");
    const d = Date.now();
    await c.close();
    console.log("log-on " + (b - a) + " ms, query " + (d - b) + " ms");
  }
})().catch((e) => { console.log("ERROR " + e.message); process.exit(1); });'
