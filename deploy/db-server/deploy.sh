#!/usr/bin/env bash
# Sets up and starts MongoDB on the DB SERVER (10.1.2.143) with one command. Safe to run again.
#
#   sudo bash deploy.sh           prepare the server (first run), start MongoDB, wait until healthy
#   sudo bash deploy.sh status    show the container and its health
#
# The first run generates .env with random passwords and prints the MongoDB connection string
# that goes into the app server's env/backend.env.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
cd "$HERE"

say()  { printf '\n==> %s\n' "$*"; }
die()  { printf '\n!!  %s\n' "$*" >&2; exit 1; }

command -v docker >/dev/null || die "Docker is not installed (see README, section 0)."
docker compose version >/dev/null 2>&1 || die "The docker compose plugin is missing."

if [[ ${1:-} == status ]]; then
  docker compose ps
  exit 0
fi

# Host preparation: Docker at boot, watchdog, data and backup folders, .env with generated
# passwords, nightly backup, firewall rule. It leaves an existing .env alone.
bash "$HERE/../host/setup-host.sh" db

say "Starting MongoDB"
docker compose up -d

say "Waiting for MongoDB to become healthy"
deadline=$(( $(date +%s) + 180 ))
state=starting
while (( $(date +%s) < deadline )); do
  state=$(docker inspect -f '{{.State.Health.Status}}' smartbranch-mongo 2>/dev/null || echo missing)
  [[ $state == healthy ]] && break
  sleep 3
done

docker compose ps
if [[ $state != healthy ]]; then
  docker logs --tail 30 smartbranch-mongo 2>&1 | sed 's/^/    /' >&2 || true
  die "MongoDB is $state. See the log lines above (README, Troubleshooting)."
fi

docker compose logs mongo 2>/dev/null | grep -F '[init]' || true
say "MongoDB is running and healthy. The connection string for the app server is printed above."
