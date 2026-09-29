// The fixed remote commands of the container plumbing: the image build and its
// label-scoped prune, the two networks and the gateway, the tunnel's socket, the clock and the
// health probe; and the build-leftover scan and the removal of labelled ones. As in
// scripts.ts every interpolated token is pattern-checked first, and every label filter carries
// frm.managed=1 plus this executor's id: the docker host is shared, so nothing unlabelled is ever
// listed for change, changed or removed (plan rule 6). The leftover scan reads unlabelled objects
// only to report the ones our builds made, and changes nothing.
import { frmError } from "../errors.js";
import { buildMarker } from "./image.js";
import type { RemoteLayout } from "./route.js";
import { IMAGE, NETWORK, PATH, checked, labelFilters } from "./scripts.js";

const HEX = /^[0-9a-f]{12,64}$/;
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
const HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
/** The gateway's container-side mount of `remote_root/run`, where the tunnel's socket lives. */
const GATEWAY_RUN = "/frm/run";
/** The API's /mcp route: what the relay passes when no tunnel names another (`frm executor image`). */
export const DEFAULT_MCP_PATH = "/mcp";
/** A path the relay must refuse; health sends it to prove the relay is the filtering one. */
export const RELAY_PROBE_PATH = "/api/v1/executors";
/** What the relay answers to it: 404 and its own mark. */
export const RELAY_REFUSAL = "404|refused";
/**
 * The gateway's own limits: one CPU, 256 MiB, 128 processes, no core files, and 1024 open files,
 * room for tinyproxy's 64 clients and the relay's 64 connections (two sockets each).
 * Part of the gateway's digest, so a change here replaces a running gateway.
 */
export const GATEWAY_LIMITS =
  "--cpus 1 --memory 256m --memory-swap 256m --pids-limit 128 --ulimit core=0 --ulimit nofile=1024:1024";
/** At most this many dangling images are read per leftover scan. */
const LEFTOVER_SCAN_CAP = 256;

export interface GatewaySpec {
  readonly image: string;
  /** Hostnames tinyproxy allows; sorted and deduplicated by the caller. */
  readonly allow: readonly string[];
  readonly mcpPort: number;
  /** The one path the relay passes, POST only. */
  readonly mcpPath: string;
  readonly proxyPort: number;
  /** A digest of everything above: a running gateway with another one is replaced. */
  readonly cfg: string;
}

function port(n: number, what: string): string {
  if (!Number.isSafeInteger(n) || n < 1 || n > 65_535) {
    throw frmError("validation", `refusing ${what} ${n} in a remote command`);
  }
  return String(n);
}

export class PlumbingScripts {
  /** The gateway container's name, which is also its DNS name on the internal network. */
  readonly gateway: string;
  /** The network sessions join: internal, so the gateway is their only way out. */
  readonly internal: string;
  /** The gateway's own network, for egress. */
  readonly egress: string;
  /** The reverse tunnel's socket on the docker host. */
  readonly socket: string;
  readonly #id: string;
  readonly #labels: string;
  readonly #run: string;

  constructor(executorId: string, layout: RemoteLayout, network: string) {
    this.#labels = labelFilters(executorId);
    this.#id = executorId;
    this.#run = checked(layout.run, PATH, "path");
    this.internal = checked(network, NETWORK, "network");
    this.gateway = `frm-${executorId}-gateway`;
    this.egress = `frm-${executorId}-egress`;
    this.socket = `${this.#run}/mcp.sock`;
  }

  /** Prints `<id> <size> <frm.managed>|<frm.executor>` for an image, or fails when it is absent.
   * An unlabelled image (the base) has no `Config.Labels` key at all, which `.Config.Labels`
   * would fail on: `index` reads it as empty. */
  imageInfo(ref: string): string {
    const r = checked(ref, IMAGE, "image");
    return `exec docker image inspect -f '{{.Id}} {{.Size}} {{with index .Config "Labels"}}{{index . "frm.managed"}}|{{index . "frm.executor"}}{{end}}' ${r}`;
  }

  /**
   * `git --version` inside a built image, so `frm executor image` checks it against the
   * submodule floor (§3.6) at build time instead of leaving a spawn to refuse later. Nothing is
   * reachable: no network, no mounts.
   *
   * `--rm` only covers a normal exit: a restarted daemon or a killed ssh leaves
   * the container behind, and on this shared host a leftover no reaper can see is one nobody ever
   * removes. So it carries our two labels like every other object here (plan rule 6) *and* names
   * the build marker in its command, the way each build step's `RUN : <marker> &&` does — those
   * two together are exactly what `buildLeftovers` reports and `pruneBuildLeftovers` removes.
   * The marker is `frm.executor=<id>` over EXECUTOR_ID's charset, so the one quoted word is safe.
   * `--pull never` as every sibling `docker run` here.
   */
  imageGitVersion(tag: string): string {
    return [
      "exec docker run --rm --pull never --network none",
      `--label frm.managed=1 --label frm.executor=${this.#id}`,
      `--entrypoint sh ${checked(tag, IMAGE, "tag")}`,
      `-c ': ${buildMarker(this.#id)} && exec git --version'`,
    ].join(" ");
  }

  /** The legacy builder (the host has no buildx), the context a tar on stdin; prints the id. */
  build(tag: string, hash: string): string {
    return [
      "DOCKER_BUILDKIT=0",
      "exec docker build --force-rm --pull=false -q",
      `--label frm.managed=1 --label frm.executor=${this.#id}`,
      `--label frm.image=${checked(hash, HEX, "render hash")}`,
      `-t ${checked(tag, IMAGE, "tag")} -`,
    ].join(" ");
  }

  /** Removes this executor's images but `keep`, by label only and never forced: an image a
   * container still uses stays. Prints `removed <id>` or `kept <id>` per image. */
  prune(keep: string): string {
    return [
      `keep=${checked(keep, IMAGE_ID, "image id")}`,
      `docker image ls -q --no-trunc ${this.#labels} | sort -u | while read -r i; do`,
      '  if [ "$i" = "$keep" ]; then continue; fi',
      '  if docker image rm "$i" >/dev/null 2>&1; then echo "removed $i"; else echo "kept $i"; fi',
      "done",
    ].join("\n");
  }

  /** Both networks (ours by label, else exit 4), then the gateway: kept when it runs `cfg`,
   * else replaced. Exit 4 when a name is held by something unlabelled. */
  ensureGateway(spec: GatewaySpec): string {
    const allow = spec.allow.map((h) => checked(h, HOST, "egress host"));
    const cfg = checked(spec.cfg, HEX, "gateway digest");
    const gw = `${this.#labels} --filter label=frm.role=gateway`;
    return [
      "set -e",
      "umask 077",
      `mkdir -p ${this.#run}`,
      "net() {",
      `  s=$(docker network inspect -f '{{.Internal}}|{{index .Labels "frm.managed"}}|{{index .Labels "frm.executor"}}' "$1" 2>/dev/null) || s=missing`,
      '  case "$s" in',
      `    "$2|1|${this.#id}") ;;`,
      `    missing) if [ "$2" = true ]; then i=--internal; else i=; fi; docker network create $i --label frm.managed=1 --label frm.executor=${this.#id} "$1" >/dev/null ;;`,
      '    *) echo "network $1 is not ours ($s); not touching it"; exit 4 ;;',
      "  esac",
      "}",
      `net ${this.internal} true`,
      `net ${this.egress} false`,
      `if [ -n "$(docker ps -q ${gw} --filter label=frm.gateway=${cfg} --filter status=running)" ]; then echo ok; exit 0; fi`,
      `docker ps -aq ${gw} | xargs -r docker rm -f >/dev/null`,
      `if [ -n "$(docker ps -aq --filter 'name=^/${this.gateway}$')" ]; then echo "${this.gateway} is held by a container that is not ours"; exit 4; fi`,
      [
        "docker run -d --init --pull never --restart unless-stopped",
        `--name ${this.gateway}`,
        `--label frm.managed=1 --label frm.executor=${this.#id}`,
        `--label frm.role=gateway --label frm.gateway=${cfg}`,
        '--user "$(id -u):$(id -g)"',
        GATEWAY_LIMITS,
        "--cap-drop ALL --security-opt no-new-privileges --read-only",
        "--tmpfs /tmp:rw,nosuid,nodev,size=16m",
        `--network ${this.egress} --network ${this.internal}`,
        "--log-driver json-file --log-opt max-size=1m",
        `--mount type=bind,src=${this.#run},dst=${GATEWAY_RUN},readonly`,
        `-e FRM_EGRESS_ALLOW=${allow.join(",")}`,
        `-e FRM_MCP_PORT=${port(spec.mcpPort, "mcp port")}`,
        `-e FRM_MCP_PATH=${checked(spec.mcpPath, PATH, "mcp path")}`,
        `-e FRM_PROXY_PORT=${port(spec.proxyPort, "proxy port")}`,
        `${checked(spec.image, IMAGE, "image")} /opt/frm/gateway.sh >/dev/null`,
      ].join(" "),
      "echo started",
    ].join("\n");
  }

  /** Makes way for the tunnel: ssh cannot bind a remote socket that already exists. */
  resetSocket(): string {
    return `umask 077\nmkdir -p ${this.#run}\nrm -f ${this.socket}`;
  }

  /** Epoch nanoseconds (GNU and uutils date alike). */
  clock(): string {
    return "date +%s%N";
  }

  /** `docker <version>`, `image 0|1`, and with a gateway `mcp <status or error>` (what /mcp answers
   * through the relay without a bearer: 401) and `relay <status>|<mark>` (what a REST path answers
   * through it: the relay's own 404). The leftover scan is its own, less frequent round trip. */
  health(
    image: string,
    mcp: { readonly port: number; readonly path: string } | null,
  ): string {
    const lines = [
      `v=$(docker version --format '{{.Server.Version}}' 2>/dev/null) && echo "docker $v" || echo "docker -"`,
      `if docker image inspect ${checked(image, IMAGE, "image")} >/dev/null 2>&1; then echo "image 1"; else echo "image 0"; fi`,
    ];
    if (mcp === null) return lines.join("\n");
    const at = `http://127.0.0.1:${port(mcp.port, "mcp port")}`;
    const url = `${at}${checked(mcp.path, PATH, "mcp path")}`;
    const fail = 'e=>"error:"+String(e.cause?.code??e.name)';
    const js = [
      'const o={method:"POST",signal:AbortSignal.timeout(5000)};',
      `fetch("${url}",o).then(r=>String(r.status),${fail})`,
      `.then(m=>fetch("${at}${RELAY_PROBE_PATH}",o).then(r=>r.status+"|"+(r.headers.get("x-frm-relay")??"-"),${fail})`,
      '.then(r=>console.log("mcp "+m+"\\nrelay "+r)))',
    ].join("");
    return [
      ...lines,
      `c=$(docker ps -q ${this.#labels} --filter label=frm.role=gateway --filter status=running | head -n 1)`,
      `if [ -z "$c" ]; then echo "mcp no-gateway"; else docker exec "$c" node -e '${js}' 2>&1 | tail -n 2; fi`,
    ].join("\n");
  }

  /**
   * Read-only: this executor's build leftovers on the shared host, found by the marker every build
   * step names in its command (`buildMarker`): containers (any state), and dangling images by their
   * top `docker history` step. Prints `leftover <ctr|img> <id12> <labelled|unlabelled>` for each,
   * and `leftover-scan capped` past the cap; nothing about any other object. Changes nothing.
   */
  buildLeftovers(): string {
    const ours = `1|${this.#id}`;
    return [
      `m='${buildMarker(this.#id)}'`,
      `docker ps -a --no-trunc --format '{{.ID}}|{{.Label "frm.managed"}}|{{.Label "frm.executor"}}|{{.Command}}' 2>/dev/null | while IFS='|' read -r i a b c; do`,
      '  case "$c" in *"$m"[!a-z0-9-]*|*"$m") ;; *) continue ;; esac',
      `  if [ "$a|$b" = "${ours}" ]; then l=labelled; else l=unlabelled; fi`,
      '  echo "leftover ctr $(printf %.12s "$i") $l"',
      "done",
      "n=0",
      "docker image ls -q --no-trunc --filter dangling=true 2>/dev/null | sort -u | while read -r i; do",
      `  n=$((n + 1)); if [ "$n" -gt ${LEFTOVER_SCAN_CAP} ]; then echo "leftover-scan capped"; break; fi`,
      `  s=$(docker history --no-trunc --format '{{.CreatedBy}}' "$i" 2>/dev/null | head -n 1)`,
      '  case "$s" in *"$m"[!a-z0-9-]*|*"$m") ;; *) continue ;; esac',
      `  t=$(docker image inspect -f '{{with index .Config "Labels"}}{{index . "frm.managed"}}|{{index . "frm.executor"}}{{end}}' "$i" 2>/dev/null)`,
      `  if [ "$t" = "${ours}" ]; then l=labelled; else l=unlabelled; fi`,
      '  h=${i#sha256:}; echo "leftover img $(printf %.12s "$h") $l"',
      "done",
    ].join("\n");
  }

  /**
   * Removes this executor's build containers that are not running, from a labelled listing only
   * (frm.managed=1 + frm.executor): those naming the build marker, with no frm.session and no
   * frm.role, one by one and never forced. Prints `removed ctr <id12>` or `kept ctr <id12>`. An
   * unlabelled leftover is never listed here, so it can never be named.
   */
  pruneBuildLeftovers(): string {
    return [
      `m='${buildMarker(this.#id)}'`,
      `docker ps -a --no-trunc ${this.#labels} --filter status=created --filter status=exited --filter status=dead --format '{{.ID}}|{{.Label "frm.session"}}|{{.Label "frm.role"}}|{{.Command}}' | while IFS='|' read -r i s r c; do`,
      '  if [ -n "$s" ] || [ -n "$r" ]; then continue; fi',
      '  case "$c" in *"$m"[!a-z0-9-]*|*"$m") ;; *) continue ;; esac',
      '  if docker rm "$i" >/dev/null 2>&1; then echo "removed ctr $(printf %.12s "$i")"; else echo "kept ctr $(printf %.12s "$i")"; fi',
      "done",
    ].join("\n");
  }
}

export interface BuildLeftovers {
  /** `ctr:<id12>` / `img:<id12>`: carrying frm.managed=1 and this executor's id. */
  readonly labelled: readonly string[];
  /** The same, without our labels: reported, never touched. */
  readonly unlabelled: readonly string[];
  /** The dangling-image scan stopped at its cap. */
  readonly capped: boolean;
}

const LEFTOVER = /^leftover (ctr|img) ([0-9a-f]{12}) (labelled|unlabelled)$/;

/** The `leftover …` lines of a scan; every other line is ignored. */
export function parseLeftovers(stdout: string): BuildLeftovers {
  const labelled = new Set<string>();
  const unlabelled = new Set<string>();
  let capped = false;
  for (const line of stdout.split("\n").map((l) => l.trim())) {
    if (line === "leftover-scan capped") capped = true;
    const m = LEFTOVER.exec(line);
    if (m === null) continue;
    (m[3] === "labelled" ? labelled : unlabelled).add(`${m[1]}:${m[2]}`);
  }
  return {
    labelled: [...labelled].toSorted(),
    unlabelled: [...unlabelled].toSorted(),
    capped,
  };
}

/** The clock script's output as epoch milliseconds, or null. */
export function parseClock(stdout: string): number | null {
  const digits = stdout.trim();
  if (!/^\d{10,}$/.test(digits)) return null;
  // Seconds are 10 digits until 2286; the rest is the fraction (nanoseconds, or fewer digits).
  const seconds = Number(digits.slice(0, 10));
  const fraction = Number(`0.${digits.slice(10) || "0"}`);
  return Math.round((seconds + fraction) * 1000);
}
