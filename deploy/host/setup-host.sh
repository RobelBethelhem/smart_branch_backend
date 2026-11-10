#!/usr/bin/env bash
# One-time preparation of a ZSmart Branch server. Safe to run again.
#
#   sudo bash host/setup-host.sh db     on the DB server  (10.1.2.143)
#   sudo bash host/setup-host.sh app    on the app server (10.1.2.132)
#
# Both:  starts Docker at boot (so restart:always containers come back after a reboot) and
#        installs the watchdog that restarts hung (unhealthy) containers.
# db:    checks the CPU, creates directories, generates db-server/.env with random passwords,
#        installs the nightly backup timer, opens 27017 to the app server only (if ufw/firewalld
#        is active — it never turns a firewall on by itself).
# app:   creates the uploads directory, checks the env files, and checks that MongoDB and
#        FlexCube are reachable from this server.
set -euo pipefail

ROLE=${1:-}
case "$ROLE" in
  app|db) ;;
  *) echo "usage: sudo bash $0 app|db" >&2; exit 2 ;;
esac
[[ $EUID -eq 0 ]] || { echo "run as root: sudo bash $0 $ROLE" >&2; exit 1; }

HOST_DIR=$(cd "$(dirname "$0")" && pwd)
DEPLOY_DIR=$(dirname "$HOST_DIR")
BASE=${BASE:-/opt/smartbranch}
APP_SERVER_IP=${APP_SERVER_IP:-10.1.2.132}
DB_SERVER_IP=${DB_SERVER_IP:-10.1.2.143}

say()  { printf '\n==> %s\n' "$*"; }
warn() { printf '\n!!  %s\n' "$*" >&2; }
random_password() { od -An -N24 -tx1 /dev/urandom | tr -d ' \n'; }   # 48 hex chars, URL-safe
reachable() { timeout 5 bash -c "</dev/tcp/$1/$2" 2>/dev/null; }

# ── Docker ────────────────────────────────────────────────────────────────────────
say "Checking Docker"
command -v docker >/dev/null || { echo "Docker is not installed — install Docker Engine first (README, Prerequisites)." >&2; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "The docker compose plugin (v2) is missing — install docker-compose-plugin." >&2; exit 1; }
docker --version

say "Starting Docker at every boot"
systemctl enable --now docker.service
systemctl is-enabled docker.service

# Files edited or copied from Windows end lines with CR LF. A stray CR breaks shell scripts and
# ends up inside passwords read from env files (logins then fail for no visible reason).
say "Normalising line endings (CRLF → LF) in $DEPLOY_DIR"
find "$DEPLOY_DIR" -type f \( -name '*.sh' -o -name '*.yml' -o -name '*.js' -o -name '.env*' \
  -o -name '*.env' -o -name '*.env.example' \) -exec sed -i 's/\r$//' {} +

# ── Watchdog for hung containers ─────────────────────────────────────────────────
say "Installing the container watchdog (restarts unhealthy containers, checks every minute)"
install -m 0755 "$HOST_DIR/container-watchdog.sh" /usr/local/bin/smartbranch-container-watchdog
cat > /etc/systemd/system/smartbranch-watchdog.service <<'EOF'
[Unit]
Description=Restart unhealthy ZSmart Branch containers
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/bin/smartbranch-container-watchdog
EOF
cat > /etc/systemd/system/smartbranch-watchdog.timer <<'EOF'
[Unit]
Description=Check ZSmart Branch container health every minute

[Timer]
OnBootSec=2min
OnUnitActiveSec=1min
AccuracySec=5s

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now smartbranch-watchdog.timer

# ── App server ────────────────────────────────────────────────────────────────────
if [[ $ROLE == app ]]; then
  say "Creating $BASE/data/backend-uploads (owner uid 1000 = the 'node' user inside the containers)"
  install -d -m 0755 "$BASE/data"
  install -d -m 0750 -o 1000 -g 1000 "$BASE/data/backend-uploads"

  say "Checking configuration files"
  missing=0
  for f in .env env/backend.env env/frontend.env; do
    path="$DEPLOY_DIR/app-server/$f"
    if [[ -f $path ]]; then
      chmod 600 "$path"
      echo "ok       $path"
    else
      echo "MISSING  $path  (copy $f.example and fill it in)"
      missing=1
    fi
  done
  [[ $missing == 0 ]] || warn "Create the missing files before 'docker compose up -d'."

  say "Checking network access from this server"
  if reachable "$DB_SERVER_IP" 27017; then
    echo "ok       MongoDB      $DB_SERVER_IP:27017"
  else
    warn "MongoDB at $DB_SERVER_IP:27017 is not reachable — is it running, and does the DB server's
    firewall allow $APP_SERVER_IP? (run setup-host.sh db there first)"
  fi
  # FlexCube host:port from an EZConnect string such as 10.1.1.149:1521/FCUBSPROD
  fc=$(sed -n 's/^FLEXCUBE_DB_CONNECTION_STRING=//p' "$DEPLOY_DIR/app-server/env/backend.env" 2>/dev/null | head -1)
  if [[ $fc =~ ^([^:/]+):([0-9]+)/ ]]; then
    if reachable "${BASH_REMATCH[1]}" "${BASH_REMATCH[2]}"; then
      echo "ok       FlexCube     ${BASH_REMATCH[1]}:${BASH_REMATCH[2]}"
    else
      warn "FlexCube at ${BASH_REMATCH[1]}:${BASH_REMATCH[2]} is not reachable from this server."
    fi
  else
    echo "skip     FlexCube     (set FLEXCUBE_DB_CONNECTION_STRING as host:port/service to check it)"
  fi
fi

# ── DB server ─────────────────────────────────────────────────────────────────────
if [[ $ROLE == db ]]; then
  say "Checking the CPU for AVX (required by MongoDB 5.0 and later)"
  if grep -qw avx /proc/cpuinfo; then
    echo "ok: AVX available"
  else
    warn "This CPU does not expose AVX: MongoDB 8 will crash at start ('Illegal instruction').
    On a VM, ask the virtualisation team to pass the host CPU features through (e.g. CPU type
    'host' / disable EVC baseline masking) before going further."
  fi

  say "Creating $BASE/mongo/data and $BASE/backups/mongo"
  install -d -m 0700 "$BASE/mongo" "$BASE/mongo/data" "$BASE/backups" "$BASE/backups/mongo"

  ENV_FILE="$DEPLOY_DIR/db-server/.env"
  if [[ -f $ENV_FILE ]]; then
    say "$ENV_FILE exists — keeping it"
  else
    say "Generating $ENV_FILE with random passwords"
    cp "$DEPLOY_DIR/db-server/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    while grep -q '__GENERATE__' "$ENV_FILE"; do
      sed -i "0,/__GENERATE__/s//$(random_password)/" "$ENV_FILE"
    done
  fi
  chmod 600 "$ENV_FILE"

  say "Installing the nightly MongoDB backup (01:30, keeps 14 days in $BASE/backups/mongo)"
  install -m 0755 "$DEPLOY_DIR/db-server/backup-mongo.sh" /usr/local/bin/smartbranch-mongo-backup
  cat > /etc/systemd/system/smartbranch-mongo-backup.service <<EOF
[Unit]
Description=Back up the ZSmart Branch MongoDB databases
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
Environment=BACKUP_DIR=$BASE/backups/mongo
Environment=RETENTION_DAYS=14
ExecStart=/usr/local/bin/smartbranch-mongo-backup
EOF
  cat > /etc/systemd/system/smartbranch-mongo-backup.timer <<'EOF'
[Unit]
Description=Nightly ZSmart Branch MongoDB backup

[Timer]
OnCalendar=*-*-* 01:30:00
Persistent=true

[Install]
WantedBy=timers.target
EOF
  systemctl daemon-reload
  systemctl enable --now smartbranch-mongo-backup.timer

  say "Firewall: MongoDB (27017/tcp) reachable from the app server $APP_SERVER_IP only"
  if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
    ufw allow from "$APP_SERVER_IP" to any port 27017 proto tcp comment 'ZSmart Branch app server to MongoDB'
    ufw status | grep 27017 || true
    echo "(ufw denies other incoming connections by default; remove any older 'allow 27017' rule)"
  elif command -v firewall-cmd >/dev/null && firewall-cmd --state >/dev/null 2>&1; then
    rule="rule family=ipv4 source address=$APP_SERVER_IP port port=27017 protocol=tcp accept"
    firewall-cmd --permanent --query-rich-rule="$rule" >/dev/null || firewall-cmd --permanent --add-rich-rule="$rule"
    firewall-cmd --reload
    echo "(firewalld rejects other incoming connections unless a zone allows them)"
  else
    warn "No active ufw or firewalld found. MongoDB still requires a password, but also restrict
    port 27017 to $APP_SERVER_IP in the server or network firewall."
  fi

  # shellcheck disable=SC1090
  source "$ENV_FILE"
  say "Connection string for the app server — paste it into app-server/env/backend.env"
  echo "  DB=mongodb://smartbranch_app:${SMARTBRANCH_DB_PASSWORD}@${MONGO_BIND_IP}:27017/${SMARTBRANCH_DB_NAME}?authSource=admin"
  echo "  (shown again any time with: sudo bash $0 db)"
fi

say "Done ($ROLE server)"
