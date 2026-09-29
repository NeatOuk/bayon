// The fixed remote commands of the container executor. Every token
// interpolated here is checked against a pattern first (ids, hex, zod-constrained paths and
// numbers), so no command needs quoting, and none carries a secret: a program, its cwd and its
// env travel as frames on stdin.
import { frmError } from "../errors.js";
import { GIT_ENV_FLOOR_SH, safeGitArgs } from "../git.js";
import type { ContainerExecutorConfig } from "./config.js";
import { EXECUTOR_ID } from "./ref.js";
import {
  normalPath,
  SESSION_ID,
  within,
  type ContainerPaths,
  type RemoteLayout,
} from "./route.js";

/**
 * The characters a path in a remote command may use — nothing about its shape: `..` and `.` pass
 * this and `within` is a plain prefix test, so anything reached from outside must go through
 * `normalPath` (route.ts) *first*. `uploadPack` does.
 */
export const PATH = /^\/[A-Za-z0-9._/-]+$/;
const HEX12 = /^[0-9a-f]{12}$/;
const TOKEN = /^[0-9a-f]{16}$/;
const SHA256 = /^[0-9a-f]{64}$/;
/** A tag or an image id: what `image` and `base_image` may name. */
export const IMAGE = /^(?:sha256:[0-9a-f]{64}|[a-z0-9][a-z0-9._/:@-]{0,254})$/;
export const NETWORK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const MEMORY = /^[1-9]\d*[kmg]$/;
/** A supervisor's FRM_HOME_TAG: `fh-` and 24 hex of its home's sha256. */
const HOME_TAG = /^fh-[0-9a-f]{24}$/;
const CTL_OP = /^(?:probe|INT|TERM|KILL|HUP)$/;
/** A remote mirror's name: a repo id, never a path. */
export const MIRROR_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/**
 * A pin ref in an executor's mirror (a gate's pinned head
 * (`refs/frm/gate/<gate id>`) or a pinned session's (`refs/frm/pin/<session id>`). The only refs
 * this executor ever deletes, and only through `dropPins`.
 */
export const PIN_REF = /^refs\/frm\/(gate|pin)\/([A-Za-z0-9_-]{1,64})$/;
/** At most this many refs per `dropPins`. */
export const MAX_PIN_REFS = 256;

/**
 * `git` on the docker host — or, for `uploadPack`, inside a session container — with safeGitArgs'
 * flags *and* GIT_ENV_FLOOR: no hook, fsmonitor or auto maintenance of a
 * mirror there ever runs, and neither /etc/gitconfig nor that user's ~/.gitconfig is read, so no
 * `filter.*`, `url.*.insteadOf` or `core.sshCommand` written outside foreman can steer these.
 * These are the least-trusted git environments in the system: the docker host is shared, and a
 * session container's HOME is the agent's. Every word of the prefix is a fixed literal, so `env`
 * needs no quoting, and `exec env … git` keeps the exec the callers rely on.
 * `args` are shell words already checked or quoted.
 */
const shGit = (...args: string[]): string =>
  ["env", GIT_ENV_FLOOR_SH, "git", ...safeGitArgs(args)].join(" ");

/** A pin ref and the mirror (repo id) holding it. */
export interface MirrorPin {
  readonly name: string;
  readonly ref: string;
}

/** `listPins` output: well-formed `<name> <ref>` lines only, deduplicated. */
export function parsePins(stdout: string): MirrorPin[] {
  const seen = new Set<string>();
  const pins: MirrorPin[] = [];
  for (const line of stdout.split("\n")) {
    const [name = "", ref = "", ...extra] = line.trim().split(" ");
    const key = `${name} ${ref}`;
    if (extra.length > 0 || !MIRROR_NAME.test(name) || !PIN_REF.test(ref)) {
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    pins.push({ name, ref });
  }
  return pins;
}

export type CtlOp = "probe" | "INT" | "TERM" | "KILL" | "HUP";

export interface RunSpec {
  readonly sessionId: string;
  readonly uid: number;
  readonly gid: number;
  readonly limits: ContainerExecutorConfig["limits"];
  readonly image: string;
  readonly network: string;
}

export function checked(value: string, pattern: RegExp, what: string): string {
  if (!pattern.test(value)) {
    throw frmError(
      "validation",
      `refusing ${what} ${JSON.stringify(value)} in a remote command`,
    );
  }
  return value;
}

/** Every label filter carries frm.managed=1 and the (checked) executor id (plan rule 6). */
export function labelFilters(executorId: string): string {
  const id = checked(executorId, EXECUTOR_ID, "executor id");
  return `--filter label=frm.managed=1 --filter label=frm.executor=${id}`;
}

export function whole(n: number, what: string): string {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw frmError("validation", `refusing ${what} ${n} in a remote command`);
  }
  return String(n);
}

function positive(n: number, what: string): string {
  if (!Number.isFinite(n) || n <= 0) {
    throw frmError("validation", `refusing ${what} ${n} in a remote command`);
  }
  return String(n);
}

export class RemoteScripts {
  /** The content-addressed exec-shim on the docker host. */
  readonly shimFile: string;
  readonly #id: string;
  readonly #layout: RemoteLayout;
  readonly #paths: ContainerPaths;
  readonly #sha: string;
  /** frm.home on every session container; none without a supervisor's tag. */
  readonly #homeLabel: string;

  constructor(
    executorId: string,
    layout: RemoteLayout,
    paths: ContainerPaths,
    shimSha: string,
    homeTag?: string,
  ) {
    this.#id = checked(executorId, EXECUTOR_ID, "executor id");
    for (const path of [layout.root, paths.sessions, paths.run, paths.shim]) {
      checked(path, PATH, "path");
    }
    this.#layout = layout;
    this.#paths = paths;
    this.#sha = checked(shimSha, SHA256, "shim digest");
    this.shimFile = `${layout.bin}/exec-shim-${shimSha.slice(0, 12)}.mjs`;
    this.#homeLabel =
      homeTag === undefined
        ? ""
        : ` --label frm.home=${checked(homeTag, HOME_TAG, "home tag")}`;
  }

  /** Every label filter carries frm.managed=1 and this executor's (checked) id. */
  #labels(): string {
    return labelFilters(this.#id);
  }

  /** The layout (0700), the ssh user's ids, free disk, per-session usage (with `du`), our images. */
  guard(du: boolean): string {
    return [
      "set -e",
      "umask 077",
      `r=${this.#layout.root}`,
      'mkdir -p "$r/bin" "$r/run" "$r/mirror" "$r/work"',
      'chmod 0700 "$r" "$r/bin"',
      'echo "id $(id -u) $(id -g)"',
      `df -Pk "$r" | awk 'NR==2 {print "df", $2, $4}'`,
      ...(du
        ? [
            "echo du-measured",
            `for d in "$r"/work/*; do if [ -d "$d" ]; then du -sxk "$d"; fi; done | awk '{print "du", $1, $2}'`,
          ]
        : []),
      `docker image ls -q --no-trunc ${this.#labels()} | while read -r i; do docker image inspect -f '{{.Size}}' "$i"; done | awk '{print "img", $1}'`,
    ].join("\n");
  }

  /** Prints `ok` when the shim on the host has the expected digest, else `missing`. */
  shimCheck(): string {
    return [
      "umask 077",
      `mkdir -p ${this.#layout.bin} ${this.#layout.run}`,
      `f=${this.shimFile}`,
      `h=$( (sha256sum "$f" || shasum -a 256 "$f") 2>/dev/null | cut -d' ' -f1)`,
      `if [ "$h" = ${this.#sha} ]; then echo ok; else echo missing; fi`,
    ].join("\n");
  }

  /** Writes stdin to the shim's path atomically, then verifies its digest (exit 5 if wrong). */
  shimUpload(): string {
    return [
      "set -e",
      "umask 077",
      `f=${this.shimFile}`,
      't="$f.tmp.$$"',
      'cat > "$t"',
      'chmod 0644 "$t"',
      'mv -f "$t" "$f"',
      `h=$( (sha256sum "$f" || shasum -a 256 "$f") 2>/dev/null | cut -d' ' -f1)`,
      `if [ "$h" = ${this.#sha} ]; then echo uploaded; else echo "mismatch $h"; exit 5; fi`,
    ].join("\n");
  }

  /** One program under the shim, in a session container or (null) on the docker host, where the
   * shim confines it to remote_root/{mirror,bin,run} by real path first (its `host` mode). */
  run(container: string | null, token: string): string {
    const n = checked(token, TOKEN, "token");
    return container === null
      ? `exec node ${this.shimFile} host ${n} ${this.#layout.root}`
      : `exec docker exec -i ${checked(container, HEX12, "container id")} node ${this.#paths.shim} run ${n} ${this.#paths.run}`;
  }

  /** `ctl` for a recorded program: exit 0 alive/signalled, 3 dead or its container gone, 4 foreign. */
  ctl(container: string | null, token: string, op: CtlOp): string {
    const n = checked(token, TOKEN, "token");
    const o = checked(op, CTL_OP, "op");
    return container === null
      ? `exec node ${this.shimFile} ctl ${this.#layout.run} ${n} ${o}`
      : this.#guarded(container, `ctl ${this.#paths.run} ${n} ${o}`);
  }

  /** Kills every process in the container but init, the keepalive and the listed programs. */
  sweep(container: string, tokens: readonly string[]): string {
    const listed = tokens.map((t) => checked(t, TOKEN, "token"));
    return this.#guarded(
      container,
      ["sweep", this.#paths.run, ...listed].join(" "),
    );
  }

  /** Runs the shim in the container only if it is running and labelled as ours. */
  #guarded(container: string, shimArgs: string): string {
    const c = checked(container, HEX12, "container id");
    return [
      `s=$(docker inspect -f '{{.State.Running}}|{{index .Config.Labels "frm.managed"}}|{{index .Config.Labels "frm.executor"}}' ${c} 2>/dev/null) || { echo gone; exit 3; }`,
      'case "$s" in',
      `  "true|1|${this.#id}") exec docker exec ${c} node ${this.#paths.shim} ${shimArgs} ;;`,
      `  "false|1|${this.#id}") echo stopped; exit 3 ;;`,
      '  *) echo "foreign container: $s"; exit 4 ;;',
      "esac",
    ].join("\n");
  }

  /** Our containers for the session (`<id> <state>`), then `--`, then whatever holds its name. */
  findContainer(sessionId: string): string {
    const sid = checked(sessionId, SESSION_ID, "session id");
    return [
      `docker ps -a --no-trunc ${this.#labels()} --filter label=frm.session=${sid} --format '{{.ID}} {{.State}}'`,
      "echo --",
      `docker ps -a --no-trunc --filter 'name=^/frm-${this.#id}-${sid}$' --format '{{.ID}} {{.Label "frm.managed"}}|{{.Label "frm.executor"}}'`,
    ].join("\n");
  }

  /** The session's running container id, if any. */
  runningContainer(sessionId: string): string {
    const sid = checked(sessionId, SESSION_ID, "session id");
    return `docker ps --no-trunc ${this.#labels()} --filter label=frm.session=${sid} --filter status=running --format '{{.ID}}'`;
  }

  /** `docker rm -f`, only after its labels say it is ours (exit 4 otherwise). */
  removeContainer(container: string): string {
    const c = checked(container, HEX12, "container id");
    return [
      `s=$(docker inspect -f '{{index .Config.Labels "frm.managed"}}|{{index .Config.Labels "frm.executor"}}' ${c} 2>/dev/null) || exit 0`,
      `if [ "$s" = "1|${this.#id}" ]; then docker rm -f ${c} >/dev/null; else echo "foreign container: $s"; exit 4; fi`,
    ].join("\n");
  }

  /** The session's keepalive container: labelled, capped, read-only but its root. */
  runContainer(spec: RunSpec): string {
    const sid = checked(spec.sessionId, SESSION_ID, "session id");
    const uid = whole(spec.uid, "uid");
    const gid = whole(spec.gid, "gid");
    const memory = checked(spec.limits.memory, MEMORY, "memory");
    const root = `${this.#layout.work}/${sid}`;
    return [
      `mkdir -p -m 0700 ${root}`,
      [
        "exec docker run -d --init --pull never --restart no",
        `--name frm-${this.#id}-${sid}`,
        `--label frm.managed=1 --label frm.executor=${this.#id} --label frm.session=${sid}${this.#homeLabel}`,
        `--user ${uid}:${gid}`,
        `--cpus ${positive(spec.limits.cpus, "cpus")}`,
        `--memory ${memory} --memory-swap ${memory}`,
        `--pids-limit ${whole(spec.limits.pids, "pids")}`,
        `--ulimit core=0 --ulimit fsize=${whole(spec.limits.fsize_bytes, "fsize")}`,
        "--cap-drop ALL --security-opt no-new-privileges --read-only",
        "--tmpfs /tmp:rw,nosuid,nodev,size=512m",
        `--tmpfs ${this.#paths.run}:rw,nosuid,nodev,noexec,size=1m,mode=0700,uid=${uid},gid=${gid}`,
        `--network ${checked(spec.network, NETWORK, "network")}`,
        "--log-driver json-file --log-opt max-size=1m",
        `--mount type=bind,src=${root},dst=${this.#paths.sessions}/${sid}`,
        `--mount type=bind,src=${this.shimFile},dst=${this.#paths.shim},readonly`,
        // At its host path: a clone's alternates resolve in the container and on the host alike.
        `--mount type=bind,src=${this.#layout.mirror},dst=${this.#layout.mirror},readonly`,
        `${checked(spec.image, IMAGE, "image")} sleep infinity`,
      ].join(" "),
    ].join("\n");
  }

  /** Mirror `name` (a repo id) on the docker host, where its sessions see it read-only. */
  mirrorPath(name: string): string {
    return `${this.#layout.mirror}/${checked(name, MIRROR_NAME, "mirror name")}.git`;
  }

  /**
   * The far end of a push into mirror `name` over git's ext:: transport: the mirror
   * directory and the repository must each be their own real path under remote_root, never a
   * symlink out (security review); a missing repository is created bare; then `git
   * receive-pack` speaks the protocol on stdin and stdout. One line: ext:: splits its command on
   * spaces only. Exit 4: refused.
   *
   * `--template=` is empty on purpose: the env floor shuts /etc/gitconfig's and
   * ~/.gitconfig's `init.templateDir` out, but $GIT_TEMPLATE_DIR in that ssh user's environment
   * still installs a hook set into every mirror this creates. An empty template installs none.
   */
  receivePack(name: string): string {
    const repo = `${checked(name, MIRROR_NAME, "mirror name")}.git`;
    return [
      "set -e",
      "umask 077",
      `r=$(realpath ${this.#layout.root})`,
      'm="$r/mirror"',
      `d="$m/${repo}"`,
      'mkdir -p "$m"',
      `[ "$(realpath "$m")" = "$m" ] || { echo "refused: $m is not its own real path" >&2; exit 4; }`,
      `if [ -e "$d" ] || [ -L "$d" ]; then [ "$(realpath "$d")" = "$d" ] || { echo "refused: $d is not its own real path" >&2; exit 4; }; else ${shGit("init", "--quiet", "--bare", "--template=", '"$d"')}; fi`,
      `exec ${shGit("receive-pack", '"$d"')}`,
    ].join("; ");
  }

  /**
   * The far end of a fetch *out of* a session's repository over git's ext:: transport:
   * `git upload-pack` inside that session's own container, never on the docker host, so no git here
   * ever reads session content (M3 amendment §6.1). `dir` must lie in that session's root, and the
   * container must still be running and labelled as ours: exit 3 gone or stopped, 4 foreign. The
   * pack it writes is received by the supervisor's own git, into the supervisor's own mirror.
   *
   * `dir` is normalized before anything else: `within` is a bare prefix test and
   * PATH admits `..`, so `/frm/s/<sid>/../../../srv/frm/mirror/other.git` would otherwise pass both
   * and serve a repository outside the session.
   */
  uploadPack(container: string, sessionId: string, dir: string): string {
    const c = checked(container, HEX12, "container id");
    const sid = checked(sessionId, SESSION_ID, "session id");
    const d = checked(normalPath(dir, "path"), PATH, "path");
    const root = `${this.#paths.sessions}/${sid}`;
    if (!within(d, root)) {
      throw frmError(
        "validation",
        `refusing to serve ${JSON.stringify(dir)}: it is not in the root of session ${sid}`,
      );
    }
    return [
      `s=$(docker inspect -f '{{.State.Running}}|{{index .Config.Labels "frm.managed"}}|{{index .Config.Labels "frm.executor"}}' ${c} 2>/dev/null) || { echo gone >&2; exit 3; }`,
      'case "$s" in',
      `  "true|1|${this.#id}") exec docker exec -i ${c} ${shGit("upload-pack", d)} ;;`,
      `  "false|1|${this.#id}") echo stopped >&2; exit 3 ;;`,
      '  *) echo "foreign container: $s" >&2; exit 4 ;;',
      "esac",
    ].join("\n");
  }

  /**
   * Every pin ref of every mirror here, `<name> <ref>` per line: read only from
   * refs/frm/gate/ and refs/frm/pin/, and only in a repository that is its own real path under a
   * real-path mirror/ (a symlinked one is skipped). Exit 4: mirror/ is not its own real path.
   */
  listPins(): string {
    return [
      "set -e",
      `r=$(realpath ${this.#layout.root} 2>/dev/null) || exit 0`,
      'm="$r/mirror"',
      '[ -d "$m" ] || exit 0',
      `[ "$(realpath "$m")" = "$m" ] || { echo "refused: $m is not its own real path" >&2; exit 4; }`,
      'for d in "$m"/*.git; do',
      '  [ -d "$d" ] || continue',
      '  [ "$(realpath "$d")" = "$d" ] || continue',
      "  n=${d##*/}; n=${n%.git}",
      `  ${shGit('--git-dir="$d"', "for-each-ref", "--format='%(refname)'", "refs/frm/gate/", "refs/frm/pin/")} 2>/dev/null | while read -r ref; do printf '%s %s\\n' "$n" "$ref"; done`,
      "done",
    ].join("\n");
  }

  /**
   * Deletes pin refs from mirror `name`: each ref is checked against PIN_REF here and
   * by prefix again on the host; the mirror and the repository must be their own real paths under
   * remote_root (as for receive-pack). One `git update-ref --stdin` transaction; a missing mirror,
   * repository or ref is a no-op. Prints `dropped`; exit 4: refused. Never a push, never a refspec.
   */
  dropPins(name: string, refs: readonly string[]): string {
    const repo = `${checked(name, MIRROR_NAME, "mirror name")}.git`;
    if (refs.length === 0 || refs.length > MAX_PIN_REFS) {
      throw frmError(
        "validation",
        `refusing ${refs.length} pin refs in one remote command (1 to ${MAX_PIN_REFS})`,
      );
    }
    const listed = refs
      .map((ref) => checked(ref, PIN_REF, "pin ref"))
      .join(" ");
    return [
      "set -e",
      `r=$(realpath ${this.#layout.root} 2>/dev/null) || { echo dropped; exit 0; }`,
      'm="$r/mirror"',
      'if [ ! -e "$m" ] && [ ! -L "$m" ]; then echo dropped; exit 0; fi',
      `[ "$(realpath "$m")" = "$m" ] || { echo "refused: $m is not its own real path"; exit 4; }`,
      `d="$m/${repo}"`,
      'if [ ! -e "$d" ] && [ ! -L "$d" ]; then echo dropped; exit 0; fi',
      `[ "$(realpath "$d")" = "$d" ] || { echo "refused: $d is not its own real path"; exit 4; }`,
      `for ref in ${listed}; do case "$ref" in refs/frm/gate/*|refs/frm/pin/*) ;; *) echo "refused: $ref"; exit 4 ;; esac; done`,
      `printf 'delete %s\\n' ${listed} | ${shGit('--git-dir="$d"', "update-ref", "--stdin")}`,
      "echo dropped",
    ].join("\n");
  }

  /**
   * Each of this executor's session containers (the gateway has none) as `<frm.session>|<frm.home>|
   * <id>`: its home label is empty on a container made before an earlier change (design §4.3).
   */
  listOwned(): string {
    return `docker ps -a --no-trunc ${this.#labels()} --filter label=frm.session --format '{{.Label "frm.session"}}|{{.Label "frm.home"}}|{{.ID}}'`;
  }

  /**
   * At a session's end: removes its containers, found by all three labels, and with
   * `removeRoot` its root, remote_root/work/<sid>, once the root is its own real path under
   * remote_root (never through a symlink). Prints `released`; exit 4: refused.
   */
  release(sessionId: string, removeRoot: boolean): string {
    const sid = checked(sessionId, SESSION_ID, "session id");
    return [
      "set -e",
      `ids=$(docker ps -aq --no-trunc ${this.#labels()} --filter label=frm.session=${sid})`,
      'for c in $ids; do docker rm -f "$c" >/dev/null; done',
      ...(removeRoot
        ? [
            `r=$(realpath ${this.#layout.root})`,
            `w="$r/work/${sid}"`,
            `if [ -e "$w" ] || [ -L "$w" ]; then [ "$(realpath "$w")" = "$w" ] || { echo "refused: $w is not its own real path"; exit 4; }; rm -rf -- "$w"; fi`,
          ]
        : []),
      "echo released",
    ].join("\n");
  }
}
