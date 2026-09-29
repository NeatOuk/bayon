// The container executor: a docker host reached over ssh.
// prepare() keeps one labelled, capped keepalive container per session; exec() routes by cwd (a
// session root runs in that session's container, a supervisor chore on the docker host), and
// every program runs under the exec-shim, the only process that ever sees its env.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { stricterLimits, type HealthLimits } from "@bayon/core";
import { frmError } from "../errors.js";
import type { SlotCounter } from "../slots.js";
import type {
  Capacity,
  CleanupMode,
  ExecOpts,
  Executor,
  ExecutorHealthReport,
  ExecutorMirrors,
  KillSignal,
  MirrorPin,
  Owned,
  Prepared,
  PrepareSpec,
  ProbeState,
  Proc,
  PtyProc,
  ReleaseOptions,
  SessionPlace,
  Argv,
} from "../types.js";
import { fetchMirror, pushMirror } from "./mirror.js";
import {
  ContainerExecutorConfig,
  type ContainerExecutorConfigInput,
} from "./config.js";
import { UNKNOWN_RELEASE, type PipeControl } from "../retained.js";
import type { PipeRelease } from "../types.js";
import { pipesOf, startRemoteProc, type ExecutorDiagnostic } from "./proc.js";
import {
  assertExecutorId,
  formatRef,
  mintToken,
  parseRef,
  shortContainerId,
  type ContainerRef,
} from "./ref.js";
import {
  CONTAINER_PATHS,
  layoutOf,
  normalPath,
  routeExec,
  SESSION_ID,
  type ContainerPaths,
  type RemoteLayout,
} from "./route.js";
import { gatherFacts, healthDetail, judgeHealth } from "./health.js";
import { buildImage, parseImageInfo, type BuiltImage } from "./image.js";
import {
  DEFAULT_MCP_PATH,
  GATEWAY_LIMITS,
  parseLeftovers,
  PlumbingScripts,
  type BuildLeftovers,
} from "./plumbing-scripts.js";
import { parsePins, RemoteScripts, type CtlOp } from "./scripts.js";
import { parseIdentityRef, sshEnv, sshTarget, SshTransport } from "./ssh.js";
import { runRemote, type Ran, type Transport } from "./transport.js";
import { McpTunnel, type ApiTarget } from "./tunnel.js";

const GIB = 1024 ** 3;
const DU_CACHE_MS = 5 * 60_000;
const DEAD = 3;
const FOREIGN = 4;
const OPS: Readonly<Record<KillSignal, CtlOp>> = {
  SIGINT: "INT",
  SIGTERM: "TERM",
  SIGKILL: "KILL",
  SIGHUP: "HUP",
};

export interface ContainerExecutorOptions {
  readonly id: string;
  /** Shared with admission, which holds one slot per session (§9.1). */
  readonly slots: SlotCounter;
  readonly frmHome: string;
  /** `executors.config_json`, parsed here: the boundary. */
  readonly config: ContainerExecutorConfigInput;
  /** Default: ssh per `config.ssh`. The tests pass a loopback. */
  readonly transport?: Transport;
  /** Paths inside a container; only the loopback harness moves them. */
  readonly paths?: ContainerPaths;
  readonly onDiagnostic?: (d: ExecutorDiagnostic) => void;
  /** The runners' `egressHosts`: the gateway allows them beside `config.egress_allow`. */
  readonly egressHosts?: readonly string[];
  /** The API's /mcp as the supervisor reaches it. With a gateway, this executor holds the reverse
   * tunnel the gateway relays to it; without one there is no tunnel. */
  readonly mcpUrl?: string;
  /** Its supervisor's FRM_HOME_TAG: every session container is labelled frm.home with it, so a
   * supervisor on another home sharing this docker host never reaps it. */
  readonly homeTag?: string;
}

export interface ExecutorUsage {
  readonly freePct: number;
  /** Session roots plus this executor's images: what `quota_gb` bounds. */
  readonly usedBytes: number;
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly bytes: number;
  }[];
}

interface GuardReport {
  readonly uid: number;
  readonly gid: number;
  readonly freePct: number;
  readonly imageBytes: number;
  readonly sessions: ExecutorUsage["sessions"] | null;
}

interface Live {
  readonly container: string | null;
  readonly token: string;
}

export class ContainerExecutor implements Executor {
  readonly kind = "container";
  readonly capabilities = { pty: false } as const;
  readonly id: string;
  /** Replaced wholesale by `reloadConfig`, never mutated in place. */
  #config: ContainerExecutorConfig;
  readonly #slots: SlotCounter;
  readonly #transport: Transport;
  readonly #layout: RemoteLayout;
  readonly #paths: ContainerPaths;
  readonly #scripts: RemoteScripts;
  readonly #shim: Buffer;
  /** The gateway's /mcp relay, shipped in the image. */
  readonly #relay: Buffer;
  readonly #diagnose: (d: ExecutorDiagnostic) => void;
  readonly #plumbing: PlumbingScripts;
  /** What the runners contribute to the allowlist: settled at boot, so a restart changes it. */
  readonly #egressHosts: readonly string[];
  /** The gateway's allowlist: sorted, deduplicated. Replaced wholesale by `reloadConfig`. */
  #allow: readonly string[];
  readonly #tunnel: McpTunnel | null;
  /** The API's /mcp path, when there is a tunnel. */
  readonly #mcpPath: string | null;
  readonly #containers = new Map<string, string>();
  readonly #live = new Map<string, Live>();
  /** Each exec'd program's pipes, until nothing more can come from them. */
  readonly #pipes = new Map<string, PipeControl>();
  #du: {
    readonly at: number;
    readonly sessions: ExecutorUsage["sessions"];
  } | null = null;
  #hostReady: Promise<void> | null = null;
  /** The last build-leftover scan, reused for `leftover_scan_ms`. */
  #leftovers: {
    readonly at: number;
    readonly value: BuildLeftovers;
  } | null = null;

  constructor(o: ContainerExecutorOptions) {
    this.id = assertExecutorId(o.id);
    const parsed = ContainerExecutorConfig.safeParse(o.config);
    if (!parsed.success) {
      throw frmError(
        "validation",
        `executor ${o.id}: invalid config_json: ${parsed.error.message}`,
      );
    }
    this.#config = parsed.data;
    this.#slots = o.slots;
    this.#layout = layoutOf(this.#config.remote_root);
    this.#paths = o.paths ?? CONTAINER_PATHS;
    this.#shim = readFileSync(new URL("./exec-shim.mjs", import.meta.url));
    this.#relay = readFileSync(new URL("./mcp-relay.mjs", import.meta.url));
    this.#scripts = new RemoteScripts(
      this.id,
      this.#layout,
      this.#paths,
      createHash("sha256").update(this.#shim).digest("hex"),
      o.homeTag,
    );
    this.#transport =
      o.transport ??
      new SshTransport({
        executorId: this.id,
        frmHome: o.frmHome,
        ssh: this.#config.ssh,
      });
    this.#diagnose = o.onDiagnostic ?? (() => undefined);
    this.#plumbing = new PlumbingScripts(
      this.id,
      this.#layout,
      this.#config.network,
    );
    this.#egressHosts = o.egressHosts ?? [];
    this.#allow = this.#allowFrom(this.#config.egress_allow);
    const mcp =
      o.mcpUrl === undefined || !this.#gatewayOn()
        ? null
        : parseMcpUrl(o.mcpUrl);
    this.#mcpPath = mcp?.path ?? null;
    this.#tunnel =
      mcp === null
        ? null
        : new McpTunnel({
            target: sshTarget({
              executorId: this.id,
              frmHome: o.frmHome,
              ssh: this.#config.ssh,
            }),
            env: sshEnv(parseIdentityRef(this.#config.ssh.identity_ref)),
            socket: this.#plumbing.socket,
            api: mcp.api,
            log: join(o.frmHome, "logs", `tunnel-${this.id}.log`),
            reset: async () => {
              await this.#run(this.#plumbing.resetSocket(), {
                what: `reset the tunnel socket on ${this.id}`,
                signal: AbortSignal.timeout(this.#config.timeouts.probe_ms),
              });
            },
          });
  }

  async prepare(spec: PrepareSpec): Promise<Prepared> {
    const sid = spec.sessionId;
    if (!SESSION_ID.test(sid)) {
      throw frmError("validation", `not a session id: ${JSON.stringify(sid)}`);
    }
    // `spec.root` is the supervisor's name for the root, in its own FRM_HOME. On this executor the
    // root is always remote_root/work/<sid>: derived from the session id, never remembered (§3).
    normalPath(spec.root, "root");
    const signal = AbortSignal.timeout(this.#config.timeouts.prepare_ms);
    const what = `prepare ${sid} on ${this.id}`;
    const report = await this.#guard(signal, what, false);
    await this.#ensureShim(signal, what);
    // The session's network and the gateway before its container: one round trip when running.
    await this.ensureGateway();
    const container = await this.#ensureContainer(sid, report, signal, what);
    this.#containers.set(sid, container);
    return { root: `${this.#paths.sessions}/${sid}`, ...this.gatewayUrls() };
  }

  async exec(argv: Argv, opts: ExecOpts): Promise<Proc> {
    if (opts.signal?.aborted === true) {
      throw frmError("interrupted", "exec aborted before spawn");
    }
    const route = routeExec(
      this.#layout,
      this.#paths,
      argv,
      opts.cwd,
      opts.env,
    );
    const signal = AbortSignal.timeout(this.#config.timeouts.exec_ms);
    const container =
      route.kind === "container"
        ? await this.#containerOf(route.sessionId, signal)
        : null;
    if (container === null) await this.#readyHost(signal);
    const token = mintToken();
    const ref = formatRef({ executorId: this.id, container, token });
    const child = await this.#transport.start(
      this.#scripts.run(container, token),
      signal,
    );
    const proc = await startRemoteProc({
      ref,
      child,
      argv,
      cwd: opts.cwd,
      env: opts.env,
      stdin: opts.stdin ?? "pipe",
      windowBytes: this.#config.window_bytes,
      heartbeatMs: this.#config.heartbeat_ms,
      deadmanMs: this.#config.deadman_ms,
      killGraceMs: this.#config.kill_grace_ms,
      startSignal: signal,
      ...(opts.signal === undefined ? {} : { abort: opts.signal }),
      ctl: (sig) => this.#signal(ref, sig),
      transportError: (exit, stderr) =>
        this.#transport.transportError(exit, stderr),
      onDiagnostic: this.#diagnose,
    });
    this.#live.set(ref, { container, token });
    void proc.exited.then(() => this.#live.delete(ref));
    const pipes = pipesOf(proc);
    if (pipes !== undefined) {
      this.#pipes.set(ref, pipes);
      void pipes.closed.then(() => this.#pipes.delete(ref));
    }
    return proc;
  }

  /** When the program's exit frame came; null while it runs, or for a ref this did not start. */
  exitedAt(ref: string): number | null {
    return this.#pipes.get(ref)?.exitedAt() ?? null;
  }

  /** Ends stdout and stderr of a program that exited and closes its channel. */
  releasePipes(ref: string, o: { readonly force?: boolean } = {}): PipeRelease {
    return this.#pipes.get(ref)?.release(o.force === true) ?? UNKNOWN_RELEASE;
  }

  pty(): Promise<PtyProc> {
    return Promise.reject(
      frmError(
        "validation",
        `executor ${this.id} has no pty (capabilities.pty = false): takeover (§12.5) runs on local`,
      ),
    );
  }

  async probe(ref: string): Promise<ProbeState> {
    const parsed = parseRef(ref, this.id);
    const ran = await this.#run(this.#ctlScript(parsed, "probe"), {
      what: `probe ${ref}`,
      signal: AbortSignal.timeout(this.#config.timeouts.probe_ms),
    });
    return this.#ctlOutcome(ran, ref) === "ok" ? "alive" : "dead";
  }

  async cleanup(ref: string, mode: CleanupMode): Promise<void> {
    const parsed = parseRef(ref, this.id);
    const signal = AbortSignal.timeout(this.#config.timeouts.cleanup_ms);
    const ran = await this.#run(
      this.#ctlScript(parsed, mode === "hard" ? "KILL" : "TERM"),
      { what: `cleanup ${ref}`, signal },
    );
    if (this.#ctlOutcome(ran, ref) === "dead") return;
    if (mode === "hard" && parsed.container !== null) {
      // Whatever escaped its group (setsid) dies too; the container itself is to remove.
      await this.#sweep(
        parsed.container,
        this.#liveTokens(parsed.container, ref),
        signal,
        `cleanup ${ref}`,
      );
    }
  }

  /** cleanup(hard) of a whole session: every program in its container but init and the
   * keepalive. Health runs it on the largest session when the disk is over a limit. */
  async cleanupSession(sessionId: string): Promise<void> {
    if (!SESSION_ID.test(sessionId)) {
      throw frmError(
        "validation",
        `not a session id: ${JSON.stringify(sessionId)}`,
      );
    }
    const signal = AbortSignal.timeout(this.#config.timeouts.cleanup_ms);
    const container = await this.#containerOf(sessionId, signal);
    await this.#sweep(container, [], signal, `cleanup ${sessionId}`);
  }

  capacity(): Capacity {
    return this.#slots.capacity();
  }

  /** PATH for a session's programs: the image's (`config_json.env_path`), not the supervisor's. */
  get envPath(): string {
    return this.#config.env_path;
  }

  /** A session's root, home and tmp in its container: all inside its one read-write mount. */
  placeSession(sessionId: string): SessionPlace {
    if (!SESSION_ID.test(sessionId)) {
      throw frmError(
        "validation",
        `not a session id: ${JSON.stringify(sessionId)}`,
      );
    }
    const root = `${this.#paths.sessions}/${sessionId}`;
    return { root, home: `${root}/.frm/home`, tmp: `${root}/.frm/tmp` };
  }

  /** Mirrors on the docker host, pushed into from the supervisor's; their pin
   * refs listed and dropped by two dedicated scripts, never by a push. */
  readonly mirrors: ExecutorMirrors = {
    path: (name) => this.#scripts.mirrorPath(name),
    push: (o) => this.#push(o),
    fetchFromSession: (o) => this.#fetchFromSession(o),
    listPins: () => this.#listPins(),
    dropPins: (name, refs) => this.#dropPins(name, refs),
  };

  /**
   * Each session container here, by label: the reconciler's orphans (   * A line whose session label is not a session id is skipped; an empty frm.home is null.
   */
  async listOwned(): Promise<readonly Owned[]> {
    const ran = await this.#run(this.#scripts.listOwned(), {
      what: `list the session containers of ${this.id}`,
      signal: AbortSignal.timeout(this.#config.timeouts.probe_ms),
    });
    if (ran.code !== 0) {
      throw frmError(
        "internal",
        `listing the containers of ${this.id} failed: ${ran.stderr.trim().slice(-500)}`,
      );
    }
    return lines(ran.stdout).flatMap((line): Owned[] => {
      const [sessionId = "", home = "", ref = ""] = line.split("|");
      return SESSION_ID.test(sessionId) && ref !== ""
        ? [
            {
              kind: "container",
              sessionId,
              ref,
              homeTag: home === "" ? null : home,
            },
          ]
        : [];
    });
  }

  /** An ended session's containers go, by label; its root too when asked. */
  async release(sessionId: string, o: ReleaseOptions): Promise<void> {
    const ran = await this.#run(
      this.#scripts.release(sessionId, o.root === "remove"),
      {
        what: `release ${sessionId} on ${this.id}`,
        signal: AbortSignal.timeout(this.#config.timeouts.prepare_ms),
      },
    );
    this.#containers.delete(sessionId);
    if (ran.code === 0 && ran.stdout.includes("released")) return;
    throw frmError(
      ran.code === FOREIGN ? "validation" : "internal",
      `release ${sessionId} on ${this.id}: ${(ran.stdout + ran.stderr).trim().slice(-500)}`,
    );
  }

  async #push(o: Parameters<ExecutorMirrors["push"]>[0]): Promise<void> {
    const command = this.#scripts.receivePack(o.name);
    const program = await this.#transport.program(command, o.signal);
    try {
      await pushMirror({
        localMirror: o.localMirror,
        refspecs: o.refspecs,
        program,
        path: process.env["PATH"] ?? "/usr/bin:/bin",
        signal: o.signal,
        what: `push into mirror ${o.name} on ${this.id}`,
      });
    } finally {
      program.release();
    }
  }

  /** The pack served by `git upload-pack` in the session's own container. */
  async #fetchFromSession(
    o: Parameters<ExecutorMirrors["fetchFromSession"]>[0],
  ): Promise<void> {
    const container = await this.#containerOf(o.sessionId, o.signal);
    // Built (and so validated) before the transport is asked for anything.
    const command = this.#scripts.uploadPack(container, o.sessionId, o.dir);
    const program = await this.#transport.program(command, o.signal);
    try {
      await fetchMirror({
        localMirror: o.localMirror,
        refspecs: o.refspecs,
        program,
        path: process.env["PATH"] ?? "/usr/bin:/bin",
        signal: o.signal,
        what: `fetch ${o.dir} of ${o.sessionId} from ${this.id}`,
      });
    } finally {
      program.release();
    }
  }

  async #listPins(): Promise<readonly MirrorPin[]> {
    const ran = await this.#run(this.#scripts.listPins(), {
      what: `list the pin refs of ${this.id}`,
      signal: AbortSignal.timeout(this.#config.timeouts.probe_ms),
    });
    if (ran.code !== 0) {
      throw frmError(
        ran.code === FOREIGN ? "validation" : "internal",
        `listing the pin refs of ${this.id} failed: ${(ran.stdout + ran.stderr).trim().slice(-500)}`,
      );
    }
    return parsePins(ran.stdout);
  }

  async #dropPins(name: string, refs: readonly string[]): Promise<void> {
    // Built (and so validated) before anything is started.
    const command = this.#scripts.dropPins(name, refs);
    const ran = await this.#run(command, {
      what: `drop ${refs.length} pin ref(s) from mirror ${name} on ${this.id}`,
      signal: AbortSignal.timeout(this.#config.timeouts.cleanup_ms),
    });
    if (ran.code === 0 && ran.stdout.trim().endsWith("dropped")) return;
    throw frmError(
      ran.code === FOREIGN ? "validation" : "internal",
      `dropping pin refs from mirror ${name} on ${this.id}: ${(ran.stdout + ran.stderr).trim().slice(-500)}`,
    );
  }

  /** Disk use for health: over the limit it cleans up the largest session. */
  async usage(): Promise<ExecutorUsage> {
    const signal = AbortSignal.timeout(this.#config.timeouts.probe_ms);
    const report = await this.#guard(signal, `usage of ${this.id}`, true);
    return this.#usageOf(report);
  }

  /** The round-trip time, for health and the certification report. */
  stats(): { readonly rttMs: number | null } {
    return { rttMs: this.#transport.rttMs() };
  }

  /** Where this executor's programs reach /mcp and the egress proxy: the gateway, by its name on
   * the internal network. Empty without a gateway (network `none`). */
  gatewayUrls(): { readonly mcpUrl?: string; readonly proxyUrl?: string } {
    if (!this.#gatewayOn()) return {};
    const { gateway } = this.#plumbing;
    const { mcp_port, proxy_port } = this.#config.gateway;
    return {
      ...(this.#mcpPath === null
        ? {}
        : { mcpUrl: `http://${gateway}:${mcp_port}${this.#mcpPath}` }),
      proxyUrl: `http://${gateway}:${proxy_port}`,
    };
  }

  /** §6.1 health, bounded by `timeouts.health_ms`; never rejects. Judged
   * against the fleet's limits as this executor's own `min_free_pct` and `clock_skew_max_ms`
   * tighten them. It (re)starts the tunnel and the gateway, and over a disk limit cleans up the
   * largest session. */
  async health(fleet: HealthLimits): Promise<ExecutorHealthReport> {
    this.#tunnel?.start();
    const signal = AbortSignal.timeout(this.#config.timeouts.health_ms);
    const tunnel = this.#tunnel;
    const facts = await gatherFacts({
      scripts: this.#plumbing,
      run: (command, what) =>
        this.#run(command, { what: `${what} on ${this.id}`, signal }),
      usage: () => this.usage(),
      leftovers: () => this.buildLeftovers({ signal }),
      image: this.#config.image,
      ensureGateway: this.#gatewayOn() ? () => this.ensureGateway() : null,
      tunnel: tunnel === null ? null : () => tunnel.state(),
      mcp:
        this.#mcpPath === null
          ? null
          : { port: this.#config.gateway.mcp_port, path: this.#mcpPath },
      now: Date.now,
    });
    const limits = {
      ...stricterLimits(fleet, {
        minFreePct: this.#config.min_free_pct,
        clockSkewMaxMs: this.#config.clock_skew_max_ms,
      }),
      quotaGb: this.#config.quota_gb,
    };
    const verdict = judgeHealth(facts, limits);
    const failures = [...verdict.failures];
    let reclaimed: string | null = null;
    if (verdict.reclaim !== null) {
      try {
        await this.cleanupSession(verdict.reclaim);
        reclaimed = verdict.reclaim;
      } catch (e) {
        failures.push(
          `disk: cannot clean up ${verdict.reclaim}: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }
    return {
      healthy: failures.length === 0,
      detail: healthDetail(
        facts,
        { failures, warnings: verdict.warnings, reclaim: verdict.reclaim },
        {
          checkedAt: Date.now(),
          rttMs: this.#transport.rttMs(),
          image: this.#config.image,
          root: this.#config.remote_root,
          limits,
          reclaimed,
        },
      ),
    };
  }

  /**
   * What this executor's row now names that can be adopted mid-life: its image tag and
   * its egress allowlist. `frm executor image` writes a new tag into the row while the supervisor
   * runs; an executor still on the boot-time tag builds its gateway's `cfg` digest from it and so
   * removes the gateway that rebuild had just started, as one whose config differs, then cannot
   * start another because the old image has been pruned.
   *
   * `egress_allow` is adopted with it, because the gateway's digest is over both:
   * `frm executor image` starts a gateway on the row's allowlist, and a supervisor adopting only
   * the image would tear that one down on its next `ensureGateway()` and put back one on its
   * *boot-time* allowlist — silently reverting an egress control while the operator's terminal said
   * the new one was applied. What the runners contribute (`egressHosts`) is not in the row and is
   * settled at boot, so a code change there still needs a restart; a change here that is only in
   * the runners is reported by `frm executor image`'s own note, not adopted.
   *
   * Nothing else is adopted: the ssh master and the tunnel are already open on the old settings,
   * and the layout and plumbing are derived from them at construction. A row that does not parse is
   * its own answer, not silence — an operator's edit that the supervisor ignores must say so.
   */
  reloadConfig(config: unknown): string | null {
    const parsed = ContainerExecutorConfig.safeParse(config);
    if (!parsed.success) {
      return `config_json it cannot parse, so it holds its boot-time settings: ${parsed.error.message.slice(0, 200)}`;
    }
    const allow = this.#allowFrom(parsed.data.egress_allow);
    const changed = [
      ...(parsed.data.image === this.#config.image
        ? []
        : [`image ${this.#config.image} → ${parsed.data.image}`]),
      ...(sameList(allow, this.#allow)
        ? []
        : [`egress allow ${this.#allow.join(",")} → ${allow.join(",")}`]),
    ];
    if (changed.length === 0) return null;
    this.#config = {
      ...this.#config,
      image: parsed.data.image,
      egress_allow: parsed.data.egress_allow,
    };
    this.#allow = allow;
    return changed.join("; ");
  }

  /** The gateway's allowlist: the runners' hosts and the row's, sorted and deduplicated. */
  #allowFrom(egressAllow: readonly string[]): readonly string[] {
    return [...new Set([...this.#egressHosts, ...egressAllow])].toSorted();
  }

  /**
   * The id the docker host holds this executor's configured image under. The tag alone
   * does not identify it: `frm executor image` tags by render hash, and two builds of the same
   * context can still differ (a base re-pulled under the same name, an install line that fetched a
   * newer package). The id is what a certification pins. Null when it cannot be read — the host is
   * unreachable, or the image is gone, both of which health already reports as failures.
   *
   * Null is never silent. On a container this id is the only pin a certification
   * has, so a read that answers null while the suite is sealing its report yields a certification
   * that pins nothing — the one `unattended_allowed` now refuses. Every way it can answer null
   * leaves a diagnostic behind.
   */
  async imageIdentity(): Promise<string | null> {
    const image = this.#config.image;
    const unreadable = (detail: string): null => {
      this.#diagnose({ kind: "image_unreadable", ref: image, detail });
      return null;
    };
    const ran = await this.#run(this.#plumbing.imageInfo(image), {
      what: `identify the image of ${this.id}`,
      signal: AbortSignal.timeout(this.#config.timeouts.probe_ms),
    }).catch((e: unknown) =>
      unreadable(e instanceof Error ? e.message : String(e)),
    );
    if (ran === null) return null;
    return (
      parseImageInfo(ran, this.id)?.id ??
      unreadable(
        `docker image inspect exited ${String(ran.code)}: ${(ran.stdout + ran.stderr).trim().slice(-200)}`,
      )
    );
  }

  /** `frm executor image`: the runner-neutral image from `base_image` and the runners' install
   * lines, tagged by its render hash; an image already built from the same context is reused.
   * `gitPatched` is the submodule floor (§3.6) the built image's own git is checked against
   * — pass `workspace.git_patched`, so a build and a spawn judge by the same list. */
  buildImage(
    installs: readonly string[],
    gitPatched: readonly string[],
  ): Promise<BuiltImage> {
    const signal = AbortSignal.timeout(this.#config.timeouts.build_ms);
    return buildImage({
      executorId: this.id,
      scripts: this.#plumbing,
      run: (command, what, input) =>
        this.#run(command, {
          what: `${what} on ${this.id}`,
          signal,
          ...(input === undefined ? {} : { input }),
        }),
      baseImage: this.#config.base_image,
      installs,
      shim: this.#shim,
      relay: this.#relay,
      gitPatched,
    });
  }

  /**
   * This executor's build leftovers on the shared host, labelled or not, found by the build marker
   *. Read-only. The scan reads every dangling image's history, so its answer is
   * reused for `leftover_scan_ms` unless `fresh`.
   */
  async buildLeftovers(
    o: { readonly fresh?: boolean; readonly signal?: AbortSignal } = {},
  ): Promise<BuildLeftovers> {
    const cached = this.#leftovers;
    if (
      o.fresh !== true &&
      cached !== null &&
      Date.now() - cached.at < this.#config.leftover_scan_ms
    ) {
      return cached.value;
    }
    const ran = await this.#run(this.#plumbing.buildLeftovers(), {
      what: `scan the build leftovers of ${this.id}`,
      signal: o.signal ?? AbortSignal.timeout(this.#config.timeouts.health_ms),
    });
    if (ran.code !== 0) {
      throw frmError(
        "internal",
        `the build-leftover scan on ${this.id} failed: ${ran.stderr.trim().slice(-500)}`,
      );
    }
    const value = parseLeftovers(ran.stdout);
    this.#leftovers = { at: Date.now(), value };
    return value;
  }

  /** Removes this executor's stopped build containers, found by label and the build marker, never
   * forced; unlabelled leftovers are only ever reported, by health. */
  async pruneBuildLeftovers(): Promise<{
    readonly removed: readonly string[];
    readonly kept: readonly string[];
  }> {
    const ran = await this.#run(this.#plumbing.pruneBuildLeftovers(), {
      what: `remove the build leftovers of ${this.id}`,
      signal: AbortSignal.timeout(this.#config.timeouts.prepare_ms),
    });
    // What health last saw no longer holds.
    this.#leftovers = null;
    if (ran.code !== 0) {
      throw frmError(
        "internal",
        `removing the build leftovers of ${this.id} failed: ${ran.stderr.trim().slice(-500)}`,
      );
    }
    return {
      removed: tagged(ran.stdout, "removed ctr"),
      kept: tagged(ran.stdout, "kept ctr"),
    };
  }

  /** Removes this executor's images other than `keep`: by label, never forced. */
  async pruneImages(keep: string): Promise<{
    readonly removed: readonly string[];
    readonly kept: readonly string[];
  }> {
    const ran = await this.#run(this.#plumbing.prune(keep), {
      what: `prune the images of ${this.id}`,
      signal: AbortSignal.timeout(this.#config.timeouts.prepare_ms),
    });
    if (ran.code !== 0) {
      throw frmError(
        "internal",
        `the image prune on ${this.id} failed: ${ran.stderr.trim().slice(-500)}`,
      );
    }
    return {
      removed: tagged(ran.stdout, "removed"),
      kept: tagged(ran.stdout, "kept"),
    };
  }

  /** The internal network, the gateway's egress network and the gateway on `image`: a no-op
   * while the gateway runs that exact configuration. */
  async ensureGateway(image: string = this.#config.image): Promise<void> {
    if (!this.#gatewayOn()) return;
    const { mcp_port: mcpPort, proxy_port: proxyPort } = this.#config.gateway;
    // Without a tunnel (`frm executor image`) the relay passes the API's own route.
    const mcpPath = this.#mcpPath ?? DEFAULT_MCP_PATH;
    const cfg = createHash("sha256")
      .update(
        JSON.stringify([
          image,
          this.#allow,
          mcpPort,
          proxyPort,
          mcpPath,
          GATEWAY_LIMITS,
        ]),
      )
      .digest("hex")
      .slice(0, 12);
    const ran = await this.#run(
      this.#plumbing.ensureGateway({
        image,
        allow: this.#allow,
        mcpPort,
        mcpPath,
        proxyPort,
        cfg,
      }),
      {
        what: `ensure the gateway of ${this.id}`,
        signal: AbortSignal.timeout(this.#config.timeouts.prepare_ms),
      },
    );
    if (ran.code === FOREIGN) {
      throw frmError("validation", `${this.id}: ${ran.stdout.trim()}`);
    }
    if (ran.code !== 0) {
      throw frmError(
        "spawn_failed",
        `cannot start the gateway of ${this.id}: ${(ran.stdout + ran.stderr).trim().slice(-500)}`,
      );
    }
  }

  /** The tunnel's ssh pid while it runs; for the live test that kills it. */
  tunnelPid(): number | null {
    return this.#tunnel?.pid() ?? null;
  }

  /** Stops the tunnel and closes the ssh master; bounded by `timeouts.close_ms`. */
  close(): Promise<void> {
    this.#tunnel?.stop();
    return this.#transport.close(
      AbortSignal.timeout(this.#config.timeouts.close_ms),
    );
  }

  #gatewayOn(): boolean {
    return this.#config.network !== "none";
  }

  /** The tokens of this executor's live programs in `container`, but `except`. */
  #liveTokens(container: string, except: string | null): string[] {
    return [...this.#live.entries()]
      .filter(([ref, live]) => ref !== except && live.container === container)
      .map(([, live]) => live.token);
  }

  #run(
    command: string,
    o: {
      readonly what: string;
      readonly signal: AbortSignal;
      readonly input?: Buffer;
    },
  ): Promise<Ran> {
    return runRemote(this.#transport, command, o);
  }

  #ctlScript(ref: ContainerRef, op: CtlOp): string {
    return this.#scripts.ctl(ref.container, ref.token, op);
  }

  #ctlOutcome(ran: Ran, ref: string): "ok" | "dead" {
    if (ran.code === 0) return "ok";
    if (ran.code === DEAD) return "dead";
    if (ran.code === FOREIGN) {
      throw frmError(
        "validation",
        `${ref}: ${ran.stdout.trim()}; not touching it`,
      );
    }
    throw frmError(
      "internal",
      `ctl for ${ref} exited ${ran.code}: ${(ran.stderr || ran.stdout).trim().slice(-500)}`,
    );
  }

  async #signal(ref: string, signal: KillSignal): Promise<void> {
    const parsed = parseRef(ref, this.id);
    const ran = await this.#run(this.#ctlScript(parsed, OPS[signal]), {
      what: `signal ${ref}`,
      signal: AbortSignal.timeout(this.#config.timeouts.cleanup_ms),
    });
    this.#ctlOutcome(ran, ref);
  }

  /** Kills every process in `container` but init, the keepalive and the programs of `keep` (this
   * executor's live refs are the authority, never the files in the container). */
  async #sweep(
    container: string,
    keep: readonly string[],
    signal: AbortSignal,
    what: string,
  ): Promise<void> {
    const ran = await this.#run(this.#scripts.sweep(container, keep), {
      what: `${what}: sweep`,
      signal,
    });
    if (ran.code === 0 || ran.code === DEAD) return;
    if (ran.code === FOREIGN) {
      throw frmError(
        "validation",
        `${what}: ${ran.stdout.trim()}; not touching it`,
      );
    }
    throw frmError(
      "spawn_failed",
      `${what}: the sweep failed (${ran.code}): ${(ran.stdout + ran.stderr).trim().slice(-500)}`,
    );
  }

  async #guard(
    signal: AbortSignal,
    what: string,
    freshDu: boolean,
  ): Promise<GuardReport> {
    const cached = this.#du;
    const reuse =
      !freshDu && cached !== null && Date.now() - cached.at < DU_CACHE_MS;
    const ran = await this.#run(this.#scripts.guard(!reuse), {
      what: `${what}: disk guard`,
      signal,
    });
    if (ran.code !== 0) {
      throw frmError(
        "spawn_failed",
        `${what}: the disk guard failed: ${ran.stderr.trim().slice(-500)}`,
      );
    }
    const report = parseGuard(ran.stdout);
    const sessions = report.sessions ?? cached?.sessions ?? [];
    if (report.sessions !== null) this.#du = { at: Date.now(), sessions };
    const full = { ...report, sessions };
    if (freshDu) return full;
    const usage = this.#usageOf(full);
    const cause = {
      free_pct: Math.round(usage.freePct * 10) / 10,
      used_gb: Math.round((usage.usedBytes / GIB) * 10) / 10,
    };
    if (usage.freePct < this.#config.min_free_pct) {
      throw frmError(
        "admission_refused",
        `${what}: ${cause.free_pct} % of the docker host's disk is free, under min_free_pct ${this.#config.min_free_pct}`,
        { retryable: true, cause },
      );
    }
    if (usage.usedBytes > this.#config.quota_gb * GIB) {
      throw frmError(
        "admission_refused",
        `${what}: ${cause.used_gb} GiB in use, over quota_gb ${this.#config.quota_gb}`,
        { retryable: true, cause },
      );
    }
    return full;
  }

  #usageOf(report: GuardReport): ExecutorUsage {
    const sessions = report.sessions ?? [];
    return {
      freePct: report.freePct,
      usedBytes: sessions.reduce((sum, s) => sum + s.bytes, report.imageBytes),
      sessions,
    };
  }

  /** The shim's digest is verified on every prepare; a missing or altered one is replaced. */
  async #ensureShim(signal: AbortSignal, what: string): Promise<void> {
    const check = await this.#run(this.#scripts.shimCheck(), {
      what: `${what}: shim check`,
      signal,
    });
    if (check.code === 0 && check.stdout.trim() === "ok") return;
    const upload = await this.#run(this.#scripts.shimUpload(), {
      what: `${what}: shim upload`,
      signal,
      input: this.#shim,
    });
    if (upload.code !== 0 || upload.stdout.trim() !== "uploaded") {
      throw frmError(
        "spawn_failed",
        `${what}: cannot install the exec-shim: ${(upload.stdout + upload.stderr).trim().slice(-500)}`,
      );
    }
  }

  /** Once per executor: the host route needs the shim and its run dir, prepare or not. */
  #readyHost(signal: AbortSignal): Promise<void> {
    this.#hostReady ??= this.#ensureShim(signal, `exec on ${this.id}`).catch(
      (err: unknown) => {
        this.#hostReady = null;
        throw err;
      },
    );
    return this.#hostReady;
  }

  async #ensureContainer(
    sid: string,
    report: GuardReport,
    signal: AbortSignal,
    what: string,
  ): Promise<string> {
    const found = await this.#run(this.#scripts.findContainer(sid), {
      what: `${what}: find its container`,
      signal,
    });
    const [labelled = "", named = ""] = found.stdout.split(/^--$/m);
    const mine = lines(labelled).map((line) => {
      const [id = "", state = ""] = line.split(" ");
      return { id: shortContainerId(id), state };
    });
    const running = mine.find((c) => c.state === "running");
    if (running !== undefined) {
      // A reused container keeps nothing but init, the keepalive and live programs: kill-before-
      // adopt (Invariant 12) when the supervisor restarted, since then nothing is live.
      await this.#sweep(
        running.id,
        this.#liveTokens(running.id, null),
        signal,
        what,
      );
      return running.id;
    }
    for (const stale of mine) {
      const removed = await this.#run(this.#scripts.removeContainer(stale.id), {
        what: `${what}: remove its stopped container`,
        signal,
      });
      if (removed.code !== 0) {
        throw frmError(
          "spawn_failed",
          `${what}: cannot remove ${stale.id}: ${(removed.stdout + removed.stderr).trim()}`,
        );
      }
    }
    const foreign = lines(named).filter(
      (line) => !line.endsWith(` 1|${this.id}`),
    );
    if (foreign.length > 0) {
      throw frmError(
        "spawn_failed",
        `${what}: the name frm-${this.id}-${sid} is held by a container that is not ours; not touching it`,
      );
    }
    const ran = await this.#run(
      this.#scripts.runContainer({
        sessionId: sid,
        uid: report.uid,
        gid: report.gid,
        limits: this.#config.limits,
        image: this.#config.image,
        network: this.#config.network,
      }),
      { what: `${what}: docker run`, signal },
    );
    if (ran.code !== 0) {
      throw frmError(
        "spawn_failed",
        `${what}: docker run failed: ${ran.stderr.trim().slice(-500)}`,
      );
    }
    return shortContainerId(lines(ran.stdout).pop() ?? "");
  }

  async #containerOf(sid: string, signal: AbortSignal): Promise<string> {
    const known = this.#containers.get(sid);
    if (known !== undefined) return known;
    const ran = await this.#run(this.#scripts.runningContainer(sid), {
      what: `find the container of ${sid}`,
      signal,
    });
    const id = lines(ran.stdout)[0];
    if (ran.code !== 0 || id === undefined) {
      throw frmError(
        "spawn_failed",
        `no running container for session ${sid} on ${this.id}: prepare it first`,
      );
    }
    const container = shortContainerId(id);
    this.#containers.set(sid, container);
    return container;
  }
}

const lines = (text: string): string[] =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");

/** Two sorted lists holding the same words. */
const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** What follows `<tag> ` on each line that starts with it. */
const tagged = (text: string, tag: string): string[] =>
  lines(text)
    .filter((line) => line.startsWith(`${tag} `))
    .map((line) => line.slice(tag.length + 1));

/** The supervisor's /mcp URL: the tunnel's local end, and the path the gateway serves it at. */
function parseMcpUrl(url: string): {
  readonly api: ApiTarget;
  readonly path: string;
} {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw frmError("validation", `not an MCP URL: ${JSON.stringify(url)}`);
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw frmError(
      "validation",
      `the tunnel carries a plain http:// MCP URL without query or fragment, not ${url}`,
    );
  }
  return {
    api: { host: parsed.hostname, port: Number(parsed.port || 80) },
    path: parsed.pathname,
  };
}

function parseGuard(stdout: string): GuardReport {
  let ids: readonly [number, number] | null = null;
  let total = 0;
  let avail = 0;
  let imageBytes = 0;
  let sessions: { sessionId: string; bytes: number }[] | null = null;
  for (const line of lines(stdout)) {
    const [tag, a = "", b = ""] = line.split(/\s+/);
    if (tag === "id") ids = [Number(a), Number(b)];
    else if (tag === "du-measured") sessions ??= [];
    else if (tag === "df") {
      total = Number(a);
      avail = Number(b);
    } else if (tag === "du") {
      sessions ??= [];
      sessions.push({
        sessionId: b.split("/").pop() ?? "",
        bytes: Number(a) * 1024,
      });
    } else if (tag === "img") imageBytes += Number(a) || 0;
  }
  if (
    ids === null ||
    !Number.isSafeInteger(ids[0]) ||
    !Number.isSafeInteger(ids[1]) ||
    !(total > 0)
  ) {
    throw frmError(
      "internal",
      `the disk guard printed nothing usable: ${stdout.slice(0, 300)}`,
    );
  }
  return {
    uid: ids[0],
    gid: ids[1],
    freePct: (avail / total) * 100,
    imageBytes,
    sessions:
      stdout.includes("\ndu ") || stdout.startsWith("du ")
        ? sessions
        : sessions,
  };
}
