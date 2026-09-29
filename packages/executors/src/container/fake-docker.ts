// A stand-in `docker` for loopback tests of the container executor:
// one "container" per session, whose paths are this machine's, so `docker exec` runs the exec-shim
// directly — or, for a program the executor runs without it (`git upload-pack`), that
// program. Only the commands the executor's fixed scripts use. Test-only.
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_DOCKER = `#!/bin/sh
state="$FAKE_DOCKER_STATE"
cmd="$1"; shift
case "$cmd" in
  ps)
    sid=""; fmt=""; named=""
    while [ $# -gt 0 ]; do
      case "$1" in
        --filter) case "$2" in label=frm.session=*) sid="\${2#label=frm.session=}";; name=*) named=1;; esac; shift 2;;
        --format) fmt="$2"; shift 2;;
        *) shift;;
      esac
    done
    [ -n "$named" ] && exit 0
    case "$fmt" in *'"frm.home"'*) [ -z "$sid" ] && {
      for s in $(ls "$state"); do
        h=""; [ -f "$state/.home-$s" ] && h=$(cat "$state/.home-$s")
        printf '%s|%s|%s\\n' "$s" "$h" "$(cat "$state/$s")"
      done
      exit 0; };; esac
    case "$fmt" in *'"frm.session"'*) [ -z "$sid" ] && { ls "$state"; exit 0; };; esac
    { [ -n "$sid" ] && [ -f "$state/$sid" ]; } || exit 0
    id=$(cat "$state/$sid")
    case "$fmt" in *State*) echo "$id running";; *) echo "$id";; esac;;
  run)
    sid=""; home=""
    while [ $# -gt 0 ]; do
      case "$1" in --label) case "$2" in frm.session=*) sid="\${2#frm.session=}";; frm.home=*) home="\${2#frm.home=}";; esac; shift 2;; *) shift;; esac
    done
    n=$(ls "$state" | wc -l | tr -d ' ')
    id=$(printf 'c%063x' $((n + 1)))
    echo "$id" > "$state/$sid"
    [ -n "$home" ] && printf '%s' "$home" > "$state/.home-$sid"
    echo "$id";;
  exec)
    [ "$1" = "-i" ] && shift
    shift
    if [ "$1" = node ]; then
      shift 2
      [ "$1" = sweep ] && { echo killed=0; exit 0; }
      exec "$FAKE_NODE" "$FAKE_SHIM" "$@"
    fi
    exec "$@";;
  inspect)
    fmt=""
    while [ $# -gt 1 ]; do case "$1" in -f) fmt="$2"; shift 2;; *) shift;; esac; done
    grep -q "^$1" "$state"/* 2>/dev/null || exit 1
    case "$fmt" in *State.Running*) echo "true|1|$FAKE_EXECUTOR";; *) echo "1|$FAKE_EXECUTOR";; esac;;
  rm)
    for f in "$state"/*; do grep -q "^$2" "$f" 2>/dev/null && rm -f "$f"; done; exit 0;;
  image)
    # Only \`image inspect\` answers: a built image id, ours, so a loopback container executor has
    # an image identity to pin the way a real one does. \`image ls\` lists nothing.
    [ "$1" = inspect ] || exit 0
    printf '%s %s %s\\n' "$FAKE_IMAGE_ID" 377000000 "1|$FAKE_EXECUTOR";;
  *) echo "fake docker: $cmd" >&2; exit 1;;
esac
`;

/** What the stand-in's `docker image inspect` reports as the image's id. */
export const FAKE_IMAGE_ID = `sha256:${"e".repeat(64)}`;

export interface FakeDocker {
  /** A loopback transport's whole environment: the stand-in first on PATH, then node. */
  readonly env: Readonly<Record<string, string>>;
  /** One file per session holding its "container" id; the file's name is the session id. */
  readonly state: string;
}

/** Installs the stand-in under `dir` for executor `executorId`. */
export function installFakeDocker(dir: string, executorId: string): FakeDocker {
  const bin = join(dir, "bin");
  const state = join(dir, "docker-state");
  mkdirSync(bin, { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(bin, "docker"), FAKE_DOCKER);
  chmodSync(join(bin, "docker"), 0o755);
  return {
    state,
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
      FAKE_DOCKER_STATE: state,
      FAKE_NODE: process.execPath,
      FAKE_SHIM: fileURLToPath(new URL("./exec-shim.mjs", import.meta.url)),
      FAKE_EXECUTOR: executorId,
      FAKE_IMAGE_ID,
    },
  };
}
