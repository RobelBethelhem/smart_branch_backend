#!/usr/bin/env bash
# Restarts ZSmart Branch containers that are running but UNHEALTHY.
#
# Docker's restart policy only reacts when a container's main process exits. A process that
# hangs (still running, but no longer answering its healthcheck) stays "unhealthy" forever
# without this. Runs every minute from smartbranch-watchdog.timer (installed by setup-host.sh);
# see what it did with:  journalctl -u smartbranch-watchdog
#
# Only containers labelled com.zemenbank.smartbranch.autoheal=true are touched. MongoDB is
# deliberately not labelled: a slow database under load is not fixed by restarting it.
set -euo pipefail

LABEL=com.zemenbank.smartbranch.autoheal=true

for id in $(docker ps --quiet --filter "label=$LABEL" --filter health=unhealthy); do
  # The container may have gone away since `docker ps` listed it — skip it then.
  name=$(docker inspect --format '{{.Name}}' "$id" 2>/dev/null) || continue
  echo "restarting unhealthy container ${name#/}"
  docker restart --time 30 "$id" >/dev/null || echo "failed to restart ${name#/}" >&2
done
