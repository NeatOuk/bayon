#!/usr/bin/env bash
# Bayon's secret store on the docker host. Run as root.
#
#   /srv/bayon/<project>/secrets/                  root:root    0700
#     api/ web/ supervisor/ migrate/               root:10001   0750  mounted read-only at /run/secrets
#       <NAME>                                     root:10001   0440
#       supervisor/FRM_SSH_KEY                     10001:10001  0400  (ssh refuses group bits: review H1)
#
# Values arrive on stdin, never in argv, and are never printed; a generated password is shown once,
# on the TTY. Each file is written to a temp file in its own directory, then renamed into place.
set -euo pipefail
umask 077

ROOT=${BAYON_ROOT:-/srv/bayon}
APP_ID=${BAYON_APP_ID:-10001}
CHOWN=${BAYON_CHOWN:-chown}
TTY=${BAYON_TTY:-/dev/tty}
ACCOUNT=${BAYON_ACCOUNT:-bayon}
AUTHORIZED_KEYS=${BAYON_AUTHORIZED_KEYS:-/home/$ACCOUNT/.ssh/authorized_keys}
DOCKER=${BAYON_DOCKER:-docker}
SERVICES="api web supervisor migrate"
MIN_PASSWORD=20
MAX_BYTES=65536
# Scratch that may hold a secret: ssh-key's directory (a private key) and put's temp file. Both are
# global, so the EXIT trap sees them; cmd_put re-arms the trap, because a pipeline's subshell
# (`printf … | cmd_put`) does not inherit it (security review).
WORK=""
PUT_TMP=""
cleanup() {
  [ -z "$PUT_TMP" ] || rm -f "$PUT_TMP"
  [ -z "$WORK" ] || rm -rf "$WORK"
}
trap cleanup EXIT

die() {
  echo "secrets.sh: $*" >&2
  exit 1
}

usage() {
  cat >&2 <<'EOF'
usage: secrets.sh init <project>
       secrets.sh put <project> <service> <NAME> [--app-owned]   the value on stdin
       secrets.sh gen <project> <NAME> <service>...              32 random bytes, hex, to each service
       secrets.sh ssh-key <project> <from-cidr>                  FRM_SSH_KEY and the account's authorized_keys line
       secrets.sh password <project> [--own | --stdin]           FRM_WEB_PASSWORD_HASH: 24 random characters, or your own
                                                                 (20+) from the TTY (--own) or the first line of stdin (--stdin)
       secrets.sh list <project>                                 names, owners, modes and sizes; never a value
projects: bayon, bayon-<suffix>; services: api web supervisor migrate
EOF
  exit 2
}

check_project() { [[ $1 =~ ^bayon(-[a-z0-9]{1,16})?$ ]] || die "not a Bayon project: $1"; }
check_name() { [[ $1 =~ ^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$ ]] || die "not a secret name: $1"; }
check_service() {
  case " $SERVICES " in
    *" $1 "*) ;;
    *) die "not a service: $1 (one of: $SERVICES)" ;;
  esac
}
service_dir() { printf '%s/%s/secrets/%s' "$ROOT" "$1" "$2"; }

cmd_init() {
  local p=$1 base s
  check_project "$p"
  base="$ROOT/$p/secrets"
  mkdir -p "$base"
  chmod 0700 "$base"
  $CHOWN 0:0 "$base"
  for s in $SERVICES; do
    mkdir -p "$base/$s"
    chmod 0750 "$base/$s"
    $CHOWN "0:$APP_ID" "$base/$s"
  done
  echo "ready: $base/{api,web,supervisor,migrate}"
}

cmd_put() {
  local p=$1 s=$2 n=$3 owned=${4:-} d tmp size mode owner
  check_project "$p"
  check_service "$s"
  check_name "$n"
  case "$owned" in
    "" | --app-owned) ;;
    *) die "unknown option: $owned" ;;
  esac
  d=$(service_dir "$p" "$s")
  [ -d "$d" ] || die "$d does not exist: run secrets.sh init $p"
  tmp=$(mktemp "$d/.put.XXXXXX")
  PUT_TMP=$tmp
  trap cleanup EXIT
  cat >"$tmp" || die "$n: cannot read stdin"
  size=$(wc -c <"$tmp" | tr -d ' ')
  [ "$size" -gt 0 ] || die "$n: no value on stdin"
  [ "$size" -le "$MAX_BYTES" ] || die "$n: larger than $MAX_BYTES bytes"
  if [ "$owned" = --app-owned ]; then
    mode=0400 owner="$APP_ID:$APP_ID"
  else
    mode=0440 owner="0:$APP_ID"
  fi
  chmod "$mode" "$tmp"
  $CHOWN "$owner" "$tmp"
  mv -f "$tmp" "$d/$n"
  PUT_TMP=""
  echo "stored $s/$n ($size bytes, $owner $mode)"
}

cmd_gen() {
  local p=$1 n=$2 value s
  shift 2
  [ $# -gt 0 ] || usage
  check_project "$p"
  check_name "$n"
  for s in "$@"; do check_service "$s"; done
  value=$(openssl rand -hex 32)
  for s in "$@"; do printf '%s' "$value" | cmd_put "$p" "$s" "$n"; done
  value=""
}

cmd_ssh_key() {
  local p=$1 from=$2 line
  check_project "$p"
  [[ $from =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}$ ]] || die "from must be a CIDR, e.g. 10.123.1.128/26"
  [ -d "$(dirname "$AUTHORIZED_KEYS")" ] ||
    die "$(dirname "$AUTHORIZED_KEYS") does not exist: create the $ACCOUNT account first"
  WORK=$(mktemp -d)
  local work=$WORK
  ssh-keygen -q -t ed25519 -N '' -C "bayon-$p" -f "$work/key" >/dev/null
  cmd_put "$p" supervisor FRM_SSH_KEY --app-owned <"$work/key"
  # restrict: no pty, agent or X11 forwarding. It still allows a command and -L forwards (design
  # §3.2); from= is the scope that matters: only the supervisor's egress network can use the key.
  line="from=\"$from\",restrict,port-forwarding $(cut -d' ' -f1,2 "$work/key.pub") bayon-$p"
  {
    if [ -f "$AUTHORIZED_KEYS" ]; then grep -v " bayon-$p\$" "$AUTHORIZED_KEYS" || true; fi
    printf '%s\n' "$line"
  } >"$work/authorized_keys"
  cat "$work/authorized_keys" >"$AUTHORIZED_KEYS"
  chmod 0600 "$AUTHORIZED_KEYS"
  $CHOWN "$ACCOUNT:$ACCOUNT" "$AUTHORIZED_KEYS"
  echo "authorized for $ACCOUNT: $line"
}

cmd_password() {
  local p=$1 own=${2:-} env_file tag pw hash
  check_project "$p"
  case "$own" in
    "" | --own | --stdin) ;;
    *) die "unknown option: $own" ;;
  esac
  env_file="$ROOT/$p/release.env"
  [ -r "$env_file" ] || die "$env_file is missing: run bayon.sh install first"
  tag=$(sed -n 's/^BAYON_TAG=\([0-9a-f]\{12\}\)$/\1/p' "$env_file")
  [ -n "$tag" ] || die "no BAYON_TAG in $env_file"
  if [ "$own" = --own ]; then
    printf 'GUI password for %s (at least %d characters): ' "$p" "$MIN_PASSWORD" >>"$TTY"
    IFS= read -rs pw <"$TTY" || die "no password read"
    printf '\n' >>"$TTY"
    [ "${#pw}" -ge "$MIN_PASSWORD" ] || die "the password needs at least $MIN_PASSWORD characters"
  elif [ "$own" = --stdin ]; then
    # Automation (a staging run): the first line of stdin, its CR stripped; nothing goes to the TTY.
    pw=""
    IFS= read -r pw || [ -n "$pw" ] || die "no password on stdin"
    pw=${pw%$'\r'}
    [ "${#pw}" -ge "$MIN_PASSWORD" ] || die "the password needs at least $MIN_PASSWORD characters"
  else
    pw=$(LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | head -c 24 || true)
    [ "${#pw}" -eq 24 ] || die "cannot generate a password"
    printf '\nThe GUI password for %s, shown once: keep it in your password manager.\n\n    %s\n\n' \
      "$p" "$pw" >>"$TTY"
  fi
  hash=$(printf '%s\n' "$pw" | "$DOCKER" run --rm -i --network none --read-only --cap-drop ALL \
    --security-opt no-new-privileges:true --user "$APP_ID:$APP_ID" \
    --label frm.managed=1 --label "frm.deploy=$p" \
    "bayon-app:$tag" node /opt/bayon/apps/web/dist/server/hash-password.js) ||
    die "hash-password failed"
  pw=""
  printf '%s\n' "$hash" | cmd_put "$p" web FRM_WEB_PASSWORD_HASH
  echo "restart web for it to take effect (every login session ends): docker compose -p $p restart web"
}

cmd_list() {
  local p=$1 s d f
  check_project "$p"
  for s in $SERVICES; do
    d=$(service_dir "$p" "$s")
    [ -d "$d" ] || continue
    for f in "$d"/*; do
      [ -f "$f" ] || continue
      ls -ln "$f" | awk -v name="$s/${f##*/}" '{ print $1, $3 ":" $4, $5, name }'
    done
  done
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  init) [ $# -eq 1 ] || usage; cmd_init "$@" ;;
  put) [ $# -eq 3 ] || [ $# -eq 4 ] || usage; cmd_put "$@" ;;
  gen) [ $# -ge 3 ] || usage; cmd_gen "$@" ;;
  ssh-key) [ $# -eq 2 ] || usage; cmd_ssh_key "$@" ;;
  password) [ $# -eq 1 ] || [ $# -eq 2 ] || usage; cmd_password "$@" ;;
  list) [ $# -eq 1 ] || usage; cmd_list "$@" ;;
  *) usage ;;
esac
