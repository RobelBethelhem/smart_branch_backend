#!/usr/bin/env bash
# Deploys the three ZSmart Branch apps on the APP SERVER (10.1.2.132) with one command.
#
#   sudo bash deploy.sh              get the latest code, build, start, wait until healthy
#   sudo bash deploy.sh --no-pull    same, but build the code that is on disk (no git)
#   sudo bash deploy.sh build        get the code and build the images, but do not start them
#                                    (to prepare ahead of a maintenance window)
#   sudo bash deploy.sh --no-build   start the images named by IMAGE_TAG in .env as they are
#                                    (e.g. images loaded with `docker load`)
#   sudo bash deploy.sh rollback     go back to the release that ran before the last deploy
#   sudo bash deploy.sh status       show the containers and their health
#
# Expected layout (this file is in smart_branch_backend/deploy/app-server):
#   <folder>/smart_branch_backend     <- clone this one first; it brings deploy/ with it
#   <folder>/Smart_Branch             <- cloned by this script if missing
#   <folder>/smart_branch_backoffice  <- cloned by this script if missing
#
# The first run creates .env and env/*.env from the examples and stops, so they can be filled
# in. Every run after that is a full deployment. Each deployment gets its own image tag, and
# the previous one is remembered for `rollback`.
set -euo pipefail

# The whole script runs from main(), so bash has read all of it before `git pull` can
# replace this file underneath it.
main() {
  local action=deploy pull=1 build=1
  for arg in "$@"; do
    case "$arg" in
      rollback|status|build) action=$arg ;;
      --no-pull) pull=0 ;;
      --no-build) build=0; pull=0 ;;
      -h|--help) sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
      *) echo "unknown argument: $arg (try --help)" >&2; exit 2 ;;
    esac
  done

  HERE=$(cd "$(dirname "$0")" && pwd)
  BACKEND_DIR=$(cd "$HERE/../.." && pwd)
  ROOT=$(dirname "$BACKEND_DIR")
  cd "$HERE"

  command -v docker >/dev/null || die "Docker is not installed (see README, section 0)."
  docker compose version >/dev/null 2>&1 || die "The docker compose plugin is missing."

  case "$action" in
    status) show_status; exit 0 ;;
    rollback) rollback; exit 0 ;;
  esac

  prepare_config
  [[ $pull == 1 ]] && get_code

  if [[ $build == 1 ]]; then
    local old_tag new_tag
    old_tag=$(env_value .env IMAGE_TAG)
    new_tag="$(date +%Y.%m.%d-%H%M)-$(repo_git "$BACKEND_DIR" rev-parse --short HEAD 2>/dev/null || echo nogit)"
    say "Building release $new_tag"
    # Built under the new tag without touching .env yet (the variable overrides the file):
    # if a build fails, .env still names the release that is running.
    local service
    for service in backend backoffice frontend; do
      IMAGE_TAG=$new_tag build_service "$service"
    done
    # All three images exist. Remember the release that is running now (only if its images
    # are really here, so rollback can work), then switch .env to the new one.
    if [[ -n $old_tag && $old_tag != "$new_tag" ]] && docker image inspect "smartbranch/backend:$old_tag" >/dev/null 2>&1; then
      echo "$old_tag" > .previous-tag
    fi
    set_env_value .env IMAGE_TAG "$new_tag"
    if [[ $action == build ]]; then
      say "Built release $new_tag. Nothing was started or stopped."
      echo "    Start it with:  sudo bash $0 --no-build"
      exit 0
    fi
  else
    say "Using the images tagged $(env_value .env IMAGE_TAG) as they are (--no-build)"
  fi

  say "Starting the containers"
  docker compose up -d --no-build --remove-orphans
  if wait_healthy; then
    show_status
    say "Deployed: release $(env_value .env IMAGE_TAG) is running and healthy."
    [[ -f .previous-tag ]] && echo "    To go back to $(cat .previous-tag):  sudo bash $0 rollback"
    echo "    Old images stay on disk. List them with: docker image ls 'smartbranch/*'"
  else
    show_status
    warn "Not every container became healthy. Look at the logs above."
    [[ -f .previous-tag ]] && echo "    To go back to $(cat .previous-tag):  sudo bash $0 rollback" >&2
    exit 1
  fi
}

say()  { printf '\n==> %s\n' "$*"; }
warn() { printf '\n!!  %s\n' "$*" >&2; }
die()  { printf '\n!!  %s\n' "$*" >&2; exit 1; }

# git as whoever runs this script (often root via sudo) in a folder cloned by someone else
repo_git() { local dir=$1; shift; git -c safe.directory='*' -C "$dir" "$@"; }

# KEY=value from an env file, without executing the file. Empty if the key is absent.
env_value() { sed -n "s/^$2=//p" "$1" 2>/dev/null | head -1 | tr -d '\r'; }

set_env_value() {
  if grep -q "^$2=" "$1"; then
    sed -i "s|^$2=.*|$2=$3|" "$1"
  else
    printf '%s=%s\n' "$2" "$3" >> "$1"
  fi
}

# Creates the config files from their examples on the first run, then checks that the values
# every deployment needs have been filled in.
prepare_config() {
  local created=0 f
  for f in .env env/backend.env env/frontend.env; do
    if [[ ! -f $f ]]; then
      cp "$f.example" "$f"
      created=1
      echo "created  $HERE/$f"
    fi
    chmod 600 "$f"
  done
  if [[ $created == 1 ]]; then
    die "Fill in the file(s) just created (README, section 2), then run this again."
  fi

  local problems=() key
  [[ -n $(env_value .env NEXT_PUBLIC_API_URL) ]] || problems+=(".env: NEXT_PUBLIC_API_URL")
  [[ -n $(env_value .env NEXT_PUBLIC_RESPONSE_ENCRYPTION_KEY) ]] || problems+=(".env: NEXT_PUBLIC_RESPONSE_ENCRYPTION_KEY")
  for key in DB ACCESS_TOKEN_PRIVATE_KEY REFRESH_TOKEN_PRIVATE_KEY ACCOUNT_ENCRYPTION_KEY REQUEST_ENCRYPTION_KEY \
             FLEXCUBE_DB_USER FLEXCUBE_DB_PASSWORD FLEXCUBE_DB_CONNECTION_STRING; do
    [[ -n $(env_value env/backend.env "$key") ]] || problems+=("env/backend.env: $key")
  done
  [[ $(env_value env/backend.env DB) != *CHANGE_ME* ]] || problems+=("env/backend.env: DB still contains CHANGE_ME (put the MongoDB password in)")
  for key in FLEXCUBE_DB_USER FLEXCUBE_DB_PASSWORD FLEXCUBE_DB_CONNECTION_STRING RESPONSE_ENCRYPTION_KEY; do
    [[ -n $(env_value env/frontend.env "$key") ]] || problems+=("env/frontend.env: $key")
  done
  if (( ${#problems[@]} )); then
    printf '\n!!  These settings are still empty:\n' >&2
    printf '      %s\n' "${problems[@]}" >&2
    die "Fill them in (README, section 2), then run this again."
  fi

  # First deployment on this server: one-time host preparation (Docker at boot, watchdog for
  # hung containers, uploads folder, reachability of MongoDB and FlexCube).
  local data_dir
  data_dir=$(env_value .env DATA_DIR); data_dir=${data_dir:-/opt/smartbranch/data}
  if [[ ! -d $data_dir/backend-uploads ]]; then
    say "First deployment on this server: preparing the host"
    BASE=$(dirname "$data_dir") bash "$HERE/../host/setup-host.sh" app
    [[ -d $data_dir/backend-uploads ]] || die "$data_dir/backend-uploads was not created. See the messages above."
  fi
}

# Latest code for the three repositories. The other two are cloned next to the backend, from
# the same GitHub account and on the same branch, the first time.
get_code() {
  local branch origin base repo dir
  branch=$(repo_git "$BACKEND_DIR" branch --show-current)
  origin=$(repo_git "$BACKEND_DIR" remote get-url origin)
  base=${origin%/*}
  [[ -n $branch ]] || die "smart_branch_backend is not on a branch (detached HEAD). Check out a branch, or use --no-pull."

  say "Getting the latest code (branch $branch)"
  for repo in smart_branch_backend Smart_Branch smart_branch_backoffice; do
    dir="$ROOT/$repo"
    if [[ ! -d $dir/.git ]]; then
      echo "cloning  $repo"
      git clone --quiet --branch "$branch" "$base/$repo.git" "$dir" \
        || die "Could not clone $base/$repo.git (branch $branch). Clone it by hand into $dir, then run this again."
    else
      local current
      current=$(repo_git "$dir" branch --show-current)
      [[ $current == "$branch" ]] || warn "$repo is on branch '$current', the backend on '$branch'. Deploying it as it is."
      repo_git "$dir" pull --quiet --ff-only \
        || die "git pull failed in $dir (local changes on the server?). Fix it, or deploy what is on disk with --no-pull."
    fi
    echo "ok       $repo  $(repo_git "$dir" log -1 --format='%h %s' | cut -c1-70)"
  done
}

# One retry: a build that died on a network hiccup usually works the second time.
build_service() {
  local service=$1
  if ! docker compose build "$service"; then
    warn "Building $service failed. Trying once more."
    docker compose build "$service" || die "Building $service failed twice. Nothing was changed: the running containers are untouched."
  fi
}

# Waits up to 4 minutes for the three containers to report healthy.
wait_healthy() {
  local deadline=$(( $(date +%s) + 240 )) name state all_healthy
  say "Waiting for the containers to become healthy"
  while (( $(date +%s) < deadline )); do
    all_healthy=1
    for name in smartbranch-backend smartbranch-frontend smartbranch-backoffice; do
      state=$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || echo missing)
      [[ $state == healthy ]] || all_healthy=0
    done
    [[ $all_healthy == 1 ]] && return 0
    sleep 3
  done
  for name in smartbranch-backend smartbranch-frontend smartbranch-backoffice; do
    state=$(docker inspect -f '{{.State.Health.Status}}' "$name" 2>/dev/null || echo missing)
    if [[ $state != healthy ]]; then
      printf '\n--- %s is %s. Last log lines:\n' "$name" "$state" >&2
      docker logs --tail 25 "$name" 2>&1 | sed 's/^/    /' >&2 || true
    fi
  done
  return 1
}

show_status() {
  say "Status (release $(env_value .env IMAGE_TAG))"
  docker compose ps --format 'table {{.Name}}\t{{.Image}}\t{{.Status}}' 2>/dev/null || docker compose ps
}

rollback() {
  [[ -f .previous-tag ]] || die "No previous release is recorded (.previous-tag is missing)."
  local previous current
  previous=$(cat .previous-tag)
  current=$(env_value .env IMAGE_TAG)
  local service
  for service in backend backoffice frontend; do
    docker image inspect "smartbranch/$service:$previous" >/dev/null 2>&1 \
      || die "The image smartbranch/$service:$previous is no longer on this server. Cannot roll back to $previous."
  done
  say "Rolling back from $current to $previous"
  set_env_value .env IMAGE_TAG "$previous"
  echo "$current" > .previous-tag
  docker compose up -d --no-build --remove-orphans
  if wait_healthy; then
    show_status
    say "Rolled back: release $previous is running and healthy. (Run rollback again to return to $current.)"
  else
    show_status
    die "Rolled back to $previous, but not every container is healthy."
  fi
}

main "$@"
