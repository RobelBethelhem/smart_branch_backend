#!/usr/bin/env bash
# Backs up every MongoDB database into one compressed archive and deletes archives older than
# RETENTION_DAYS. Installed by setup-host.sh as a nightly systemd timer (smartbranch-mongo-backup);
# can also be run by hand:  sudo bash backup-mongo.sh
#
# Copy the archives off this server as well (backup share, tape …): a backup that lives only on
# the DB server is lost together with it.
#
# Restore: see README.md → "Restore a backup".
set -euo pipefail

BACKUP_DIR=${BACKUP_DIR:-/opt/smartbranch/backups/mongo}
RETENTION_DAYS=${RETENTION_DAYS:-14}
CONTAINER=${CONTAINER:-smartbranch-mongo}

mkdir -p "$BACKUP_DIR"
out="$BACKUP_DIR/mongo-$(date +%Y%m%d-%H%M%S).archive.gz"
trap 'rm -f "$out.partial"' EXIT

# The root credentials are read inside the container from its own environment. The password
# goes through a private temp file (mongodump --config), so it never shows up in `ps`.
docker exec "$CONTAINER" sh -c '
  umask 077
  cfg=$(mktemp)
  printf "password: \"%s\"\n" "$MONGO_INITDB_ROOT_PASSWORD" > "$cfg"
  mongodump --quiet --host 127.0.0.1 --port 27017 \
    --username "$MONGO_INITDB_ROOT_USERNAME" --authenticationDatabase admin \
    --config "$cfg" --archive --gzip
  rc=$?
  rm -f "$cfg"
  exit $rc
' > "$out.partial"

mv "$out.partial" "$out"
chmod 600 "$out"
find "$BACKUP_DIR" -maxdepth 1 -name 'mongo-*.archive.gz' -mtime +"$RETENTION_DAYS" -delete

echo "backup written: $out ($(du -h "$out" | cut -f1))"
