#!/usr/bin/env bash
# Operates Bayon on the shared docker host from the owner's machine (the design
# §7.5). Every docker object it creates carries frm.managed=1 and frm.deploy=<project>; every list or
# remove it runs filters on labels; it never prunes anything global and never names ctr-lab.
set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# No real address is ever written in this repository: the operator's environment names
# the ssh destination (BAYON_HOST, e.g. ops@<docker-host>) and the LAN address the GUI is published on.
HOST=${BAYON_HOST:-}
ADDR=${BAYON_ADDR:-}
SSH=${BAYON_SSH:-ssh}
ROOT=${BAYON_ROOT:-/srv/bayon}
DRAIN_WAIT=${BAYON_DRAIN_WAIT:-1800}
HEALTH_WAIT=${BAYON_HEALTH_WAIT:-300}
POLL=${BAYON_POLL:-20}
MIN_FREE_GB=35
APP_ID=10001
MAC_EXECUTOR=ctr-lab

die() {
  echo "bayon.sh: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage: bayon.sh build <git-ref>                       bayon-app:<sha12>, built on the host from git archive
       bayon.sh install <project> <sha12>             first install (re-runnable): preflights, files, volume, up
       bayon.sh upgrade <project> <sha12> [--force]   pause, drain, stop, backup + migrate, up; stays paused
       bayon.sh frm <project> <args...>               frm in the supervisor container
       bayon.sh frm <project> config apply <file.json>
                                                      seed repos, workspaces, profiles and agents from a
                                                      local file, streamed to frm
       bayon.sh known-hosts <project>                 the host's own key line into the supervisor's
                                                      /tmp/known_hosts, for frm executor add --known-hosts
       bayon.sh inventory                             the host's foreign objects (never touched) and ours
       bayon.sh down <project> [-v]                   stop; -v (bayon-stg only) removes its volume and its
                                                      executor's containers, networks and images, by label
       bayon.sh print-release <project> <sha12>       the release.env install writes
projects: bayon (port 5173, 10.123.1.0/24, executor srv-lab), bayon-stg (5183, 10.123.2.0/24, stg-lab)
environment: BAYON_HOST (ssh destination, e.g. ops@<docker-host>), BAYON_ADDR (the host's LAN address)
EOF
  exit 2
}

need_host() { [ -n "$HOST" ] || die "set BAYON_HOST: the docker host's ssh destination, e.g. ops@<docker-host>"; }
need_addr() {
  [[ $ADDR =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] ||
    die "set BAYON_ADDR: the docker host's LAN address, where the GUI is published"
}

# One command string on the host; stdin is never forwarded (see put_file).
remote() {
  need_host
  "$SSH" -o BatchMode=yes "$HOST" "$1" </dev/null
}
# stdin to a root-owned file on the host.
put_file() {
  need_host
  "$SSH" -o BatchMode=yes "$HOST" "sudo -n install -D -o root -g root -m $1 /dev/stdin $2"
}

use_project() {
  case "$1" in
    bayon) PORT=5173 NET=10.123.1 EXECUTOR=srv-lab ;;
    bayon-stg) PORT=5183 NET=10.123.2 EXECUTOR=stg-lab ;;
    *) die "unknown project: $1 (bayon or bayon-stg)" ;;
  esac
  P=$1
  DIR=$ROOT/$1
}

check_tag() { [[ $1 =~ ^[0-9a-f]{12}$ ]] || die "not an image tag (12 hex characters): $1"; }
compose() { remote "docker compose -p $P --env-file $DIR/release.env -f $DIR/compose.yaml $1"; }

release_env() {
  need_addr
  printf 'BAYON_PROJECT=%s\nBAYON_TAG=%s\nBAYON_PORT=%s\nBAYON_ADDR=%s\nBAYON_NET=%s\nBAYON_DIR=%s\n' \
    "$P" "$1" "$PORT" "$ADDR" "$NET" "$DIR"
}

check_disk() {
  local bytes free
  bytes=$(remote "df -B1 --output=avail / | tail -n 1" | tr -d ' ')
  [[ $bytes =~ ^[0-9]+$ ]] || die "cannot read the host's free disk"
  free=$((bytes / 1073741824))
  [ "$free" -ge "$MIN_FREE_GB" ] ||
    die "the host has ${free} G free, under the ${MIN_FREE_GB} G floor (design M7): reclaim space first"
}

check_image() {
  remote "docker image inspect bayon-app:$1 >/dev/null" ||
    die "no image bayon-app:$1 on the host: run bayon.sh build first"
}

wait_healthy() {
  local waited=0 states
  while :; do
    states=$(compose "ps --format '{{.Service}}={{.Health}}'" || true)
    if echo "$states" | grep -qx 'api=healthy' && echo "$states" | grep -qx 'web=healthy' &&
      echo "$states" | grep -qx 'supervisor=healthy'; then
      echo "healthy: api, supervisor, web"
      return 0
    fi
    [ "$waited" -lt "$HEALTH_WAIT" ] || die "not healthy after ${HEALTH_WAIT} s: $(echo "$states" | tr '\n' ' ')"
    sleep "$POLL"
    waited=$((waited + POLL))
  done
}

missing_secrets() {
  local listed need out=""
  listed=$(remote "sudo -n $DIR/secrets.sh list $P")
  for need in api/FRM_API_TOKEN web/FRM_API_TOKEN web/FRM_WEB_PASSWORD_HASH \
    supervisor/FRM_BACKUP_KEY migrate/FRM_BACKUP_KEY supervisor/FRM_SSH_KEY; do
    echo "$listed" | grep -q " $need\$" || out="$out $need"
  done
  echo "${out# }"
}

cmd_build() {
  local sha tag
  sha=$(git -C "$HERE/.." rev-parse --verify "$1^{commit}") || die "no commit: $1"
  tag=${sha:0:12}
  check_disk
  echo "building bayon-app:$tag from $sha on $HOST"
  git -C "$HERE/.." archive --format=tar "$sha" | "$SSH" -o BatchMode=yes "$HOST" \
    "docker build -f deploy/Dockerfile --pull=false --build-arg REVISION=$sha --label frm.managed=1 --label frm.deploy=bayon --label org.opencontainers.image.revision=$sha -t bayon-app:$tag -"
  echo "built bayon-app:$tag"
}

cmd_install() {
  use_project "$1"
  check_tag "$2"
  local tag=$2 ids taken missing
  check_image "$tag"
  check_disk
  if [ -z "$(remote "docker ps -aq --filter label=frm.managed=1 --filter label=frm.deploy=$P")" ]; then
    [ -z "$(remote "ss -ltnH 'sport = :$PORT'")" ] || die "port $PORT is in use on the host"
    taken=$(remote "ip -o route; docker network inspect \$(docker network ls -q) --format '{{range .IPAM.Config}}{{.Subnet}} {{end}}'")
    if echo "$taken" | grep -qF "$NET."; then die "$NET.0/24 overlaps a route or a docker network on the host"; fi
  fi
  ids=$(remote "id -u bayon; id -g bayon; id -nG bayon") || die "no bayon account on the host (see the staging checklist)"
  if [ "$(echo "$ids" | sed -n 1p)" = "$APP_ID" ] || [ "$(echo "$ids" | sed -n 2p)" = "$APP_ID" ]; then
    die "the bayon account must not be uid or gid $APP_ID (the containers' user)"
  fi
  echo "$ids" | sed -n 3p | grep -qw docker || die "the bayon account is not in the docker group"
  put_file 0644 "$DIR/compose.yaml" <"$HERE/compose.yaml"
  put_file 0755 "$DIR/secrets.sh" <"$HERE/secrets.sh"
  release_env "$tag" | put_file 0644 "$DIR/release.env"
  remote "sudo -n install -d -o $APP_ID -g $APP_ID -m 0700 $DIR/backups"
  remote "sudo -n $DIR/secrets.sh init $P" >/dev/null
  remote "docker volume inspect ${P}_home >/dev/null 2>&1 || docker volume create --label frm.managed=1 --label frm.deploy=$P ${P}_home >/dev/null"
  remote "docker run --rm --network none --user 0:0 --cap-drop ALL --cap-add CHOWN --label frm.managed=1 --label frm.deploy=$P -v ${P}_home:/v bayon-app:$tag chown $APP_ID:$APP_ID /v"
  missing=$(missing_secrets)
  if [ -n "$missing" ]; then
    echo "secrets still to provision (see the staging checklist): $missing"
    exit 3
  fi
  compose "up -d"
  wait_healthy
  cat <<EOF
installed $P at bayon-app:$tag: http://$ADDR:$PORT
next: bayon.sh frm $P executor add $EXECUTOR ... (checklist), then bind the reviewer role to $EXECUTOR
EOF
}

cmd_upgrade() {
  use_project "$1"
  check_tag "$2"
  local tag=$2 force=${3:-} current live waited=0 running
  case "$force" in
    "" | --force) ;;
    *) usage ;;
  esac
  check_image "$tag"
  current=$(remote "sed -n 's/^BAYON_TAG=//p' $DIR/release.env")
  check_tag "$current"
  [ "$current" != "$tag" ] || die "$P already runs bayon-app:$tag"
  echo "pausing the fleet"
  compose "exec -T supervisor frm pause"
  while :; do
    live=$(compose "exec -T api node /opt/bayon/deploy/live-sessions.mjs" | tr -d '[:space:]')
    [[ $live =~ ^[0-9]+$ ]] || die "cannot count the sessions with a turn in flight"
    [ "$live" -eq 0 ] && break
    if [ "$force" = --force ]; then
      echo "--force: $live session(s) with a turn in flight will be interrupted (design §7.4)"
      break
    fi
    [ "$waited" -lt "$DRAIN_WAIT" ] ||
      die "$live session(s) still have a turn in flight after ${DRAIN_WAIT} s: wait, or pass --force to interrupt them"
    echo "$live session(s) with a turn in flight; waiting"
    sleep "$POLL"
    waited=$((waited + POLL))
  done
  compose "stop web api supervisor"
  running=$(compose "ps --status running --services")
  if echo "$running" | grep -Eqx 'web|api|supervisor'; then
    die "still running after stop: $(echo "$running" | tr '\n' ' ')"
  fi
  # Only now, with no supervisor container running, may a lock a crash left be cleared.
  remote "docker run --rm --network none --user $APP_ID:$APP_ID --cap-drop ALL --label frm.managed=1 --label frm.deploy=$P -v ${P}_home:/v bayon-app:$current sh -c 'if [ -e /v/supervisor.lock ]; then rm -f /v/supervisor.lock; echo cleared a stale supervisor.lock; fi'"
  remote "sudo -n cp $DIR/release.env $DIR/release.env.previous"
  release_env "$tag" | put_file 0644 "$DIR/release.env"
  if ! compose "run --rm migrate"; then
    remote "sudo -n cp $DIR/release.env.previous $DIR/release.env"
    die "the migration failed: the writers stay stopped and release.env is back at $current; restore per the runbook (design §7.5)"
  fi
  compose "up -d"
  wait_healthy
  echo "upgraded $P from $current to $tag. The fleet is PAUSED: verify, then bayon.sh frm $P resume"
}

cmd_frm() {
  use_project "$1"
  shift
  [ $# -gt 0 ] || usage
  local a prev="" executor="" quoted=""
  for a in "$@"; do
    case "$a" in
      *"$MAC_EXECUTOR"*) die "refused: $MAC_EXECUTOR is the Mac's executor; this home never touches it (design §9.1)" ;;
    esac
    [ "$prev" = --executor ] && executor=$a
    case "$a" in --executor=*) executor=${a#--executor=} ;; esac
    prev=$a
  done
  if [ "$1" = runner ] && [ "${2:-}" = conformance ] && { [ -z "$executor" ] || [ "$executor" = local ]; }; then
    die "refused: conformance on local would run beside the ssh key; pass --executor $EXECUTOR (design §3.4)"
  fi
  # frm config apply <file>: the file is on this machine, not in the container, so it is
  # streamed to frm's stdin and read there as /dev/stdin; nothing is copied onto the host.
  if [ "$1" = config ] && [ "${2:-}" = apply ]; then
    [ $# -eq 3 ] || die "usage: bayon.sh frm <project> config apply <file.json>"
    { [ -f "$3" ] && [ -r "$3" ]; } || die "cannot read $3"
    if grep -q "$MAC_EXECUTOR" "$3"; then
      die "refused: $3 names $MAC_EXECUTOR, the Mac's executor; this home never touches it (design §9.1)"
    fi
    need_host
    "$SSH" -o BatchMode=yes "$HOST" \
      "docker compose -p $P --env-file $DIR/release.env -f $DIR/compose.yaml exec -T supervisor frm config apply /dev/stdin" <"$3"
    return
  fi
  for a in "$@"; do quoted="$quoted $(printf '%q' "$a")"; done
  compose "exec -T supervisor frm$quoted"
}

cmd_inventory() {
  remote 'echo "== foreign containers (no frm.managed label): never touched"
docker ps -a --no-trunc --format "{{.ID}} {{.Names}} {{.Label \"frm.managed\"}}" | awk "\$3 == \"\" { print \$1, \$2 }" | sort -k2
echo "== networks: id name managed deploy executor"
docker network ls --no-trunc --format "{{.ID}} {{.Name}} {{.Label \"frm.managed\"}} {{.Label \"frm.deploy\"}} {{.Label \"frm.executor\"}}" | sort -k2
echo "== volumes: name managed deploy"
docker volume ls --format "{{.Name}} {{.Label \"frm.managed\"}} {{.Label \"frm.deploy\"}}" | sort
echo "== ours: containers by label"
docker ps -a --filter label=frm.managed=1 --format "{{.ID}} {{.Names}} {{.Status}} deploy={{.Label \"frm.deploy\"}} executor={{.Label \"frm.executor\"}}" | sort -k2
echo "== ours: images by label"
docker image ls --filter label=frm.managed=1 --format "{{.Repository}}:{{.Tag}} {{.ID}} {{.Size}}"
echo "== disk"
df -h /
docker system df
echo "== listening"
ss -ltnH | awk "{ print \$4 }" | sort -u'
}

cmd_down() {
  use_project "$1"
  local v=${2:-}
  case "$v" in
    "")
      compose "down"
      return
      ;;
    -v) ;;
    *) usage ;;
  esac
  [ "$P" != bayon ] || die "refused: down -v never runs for bayon (its data volume is kept; design M5)"
  compose "down"
  remote "for v in \$(docker volume ls -q --filter label=frm.managed=1 --filter label=frm.deploy=$P); do if [ \"\$v\" = ${P}_home ]; then docker volume rm \"\$v\"; fi; done"
  remote "docker ps -aq --filter label=frm.managed=1 --filter label=frm.executor=$EXECUTOR | xargs -r docker rm -f; docker network ls -q --filter label=frm.managed=1 --filter label=frm.executor=$EXECUTOR | xargs -r docker network rm; docker image ls -q --filter label=frm.managed=1 --filter label=frm.executor=$EXECUTOR | sort -u | xargs -r docker image rm"
  echo "removed $P's containers, networks and volume, and $EXECUTOR's objects, by label"
  echo "left for the checklist (sudo): /home/bayon/$EXECUTOR, its authorized_keys line, $DIR"
}

# The executor's known_hosts line (design §3.2): the host's own ed25519 key, read from its file (never a
# network scan), as "<BAYON_ADDR> <key>", written into the supervisor container's /tmp/known_hosts for
# `frm executor add … --known-hosts /tmp/known_hosts`. /tmp is the container's tmpfs; add copies the
# line into FRM_HOME, so nothing needs it after.
cmd_known_hosts() {
  use_project "$1"
  need_addr
  local key re='^ssh-ed25519 [A-Za-z0-9+/]+={0,3}$'
  key=$(remote "cut -d' ' -f1,2 /etc/ssh/ssh_host_ed25519_key.pub")
  [[ $key =~ $re ]] || die "the host's ed25519 key is unreadable or not a key line"
  printf '%s %s\n' "$ADDR" "$key" | "$SSH" -o BatchMode=yes "$HOST" \
    "docker compose -p $P --env-file $DIR/release.env -f $DIR/compose.yaml exec -T supervisor sh -c 'cat > /tmp/known_hosts'"
  echo "wrote $P's supervisor /tmp/known_hosts: $ADDR ${key%% *}"
  echo "next: bayon.sh frm $P executor add $EXECUTOR --host $ADDR … --known-hosts /tmp/known_hosts"
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  build) [ $# -eq 1 ] || usage; cmd_build "$@" ;;
  known-hosts) [ $# -eq 1 ] || usage; cmd_known_hosts "$@" ;;
  install) [ $# -eq 2 ] || usage; cmd_install "$@" ;;
  upgrade) [ $# -eq 2 ] || [ $# -eq 3 ] || usage; cmd_upgrade "$@" ;;
  frm) [ $# -ge 2 ] || usage; cmd_frm "$@" ;;
  inventory) [ $# -eq 0 ] || usage; cmd_inventory ;;
  down) [ $# -eq 1 ] || [ $# -eq 2 ] || usage; cmd_down "$@" ;;
  print-release) [ $# -eq 2 ] || usage; use_project "$1"; check_tag "$2"; release_env "$2" ;;
  *) usage ;;
esac
