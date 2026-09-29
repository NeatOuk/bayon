// Container executor health: ssh, docker, disk
// against both the floor and our quota, clock skew, the image, and — with a gateway — the tunnel,
// /mcp answering 401 through it, and a REST path refused by the relay itself. The
// floor and the skew are the fleet's settings, tightened by this executor's own config. The
// measured ssh round trip goes into the detail (and so into the certification report). Over the
// disk limit the largest session is cleaned up hard, not only reported: the disk is shared with
// another stack. Build leftovers are warnings: reported, never a failure.
import { clockFailures, type HealthLimits } from "@bayon/core";
import type { ExecutorHealthReport } from "../types.js";
import type { ExecutorUsage } from "./container.js";
import {
  parseClock,
  RELAY_PROBE_PATH,
  RELAY_REFUSAL,
  type BuildLeftovers,
  type PlumbingScripts,
} from "./plumbing-scripts.js";
import type { Ran } from "./transport.js";
import type { TunnelState } from "./tunnel.js";

const GIB = 1024 ** 3;
const EXPECTED_MCP = "401";

export interface HealthFacts {
  /** Why the first round trip failed; null when ssh works. */
  readonly ssh: string | null;
  readonly clockSkewMs: number | null;
  /** The docker server's version; null when it does not answer. */
  readonly docker: string | null;
  readonly imagePresent: boolean;
  /** Why the networks or the gateway could not be ensured. */
  readonly gateway: string | null;
  /** null: this executor has no tunnel. */
  readonly tunnel: TunnelState | null;
  /** What /mcp answered through the gateway; null: not checked (no tunnel). */
  readonly mcp: string | null;
  /** `<status>|<X-Frm-Relay>` for a REST path through the gateway; null: not checked (no tunnel). */
  readonly relay: string | null;
  /** This executor's build leftovers on the host, by the build marker; null: the scan failed. */
  readonly leftovers: BuildLeftovers | null;
  readonly usage: ExecutorUsage | null;
  readonly usageError: string | null;
}

/** The fleet's limits as this executor tightened them, and its own quota. */
export type ContainerHealthLimits = HealthLimits & { readonly quotaGb: number };

export interface Verdict {
  readonly failures: readonly string[];
  /** Reported, never a failure: build leftovers. */
  readonly warnings: readonly string[];
  /** The session to clean up (hard): the largest, when the disk is over a limit. */
  readonly reclaim: string | null;
}

export const NO_LEFTOVERS: BuildLeftovers = {
  labelled: [],
  unlabelled: [],
  capped: false,
};

/** Leftovers are warnings: they stop nothing, and the unlabelled ones are not ours to remove. */
export function leftoverWarnings(l: BuildLeftovers | null): string[] {
  if (l === null) return ["build: the leftover scan did not answer"];
  return [
    ...(l.unlabelled.length === 0
      ? []
      : [
          `build: ${l.unlabelled.length} object(s) from this executor's builds carry no frm labels on the shared host (${l.unlabelled.join(", ")}); never touched here, remove them by hand`,
        ]),
    ...(l.labelled.length === 0
      ? []
      : [
          `build: ${l.labelled.length} labelled leftover(s) of this executor's builds (${l.labelled.join(", ")}); \`frm executor image\` removes them`,
        ]),
    ...(l.capped ? ["build: the dangling-image scan stopped at its cap"] : []),
  ];
}

const round1 = (n: number) => Math.round(n * 10) / 10;

export function judgeHealth(f: HealthFacts, l: ContainerHealthLimits): Verdict {
  if (f.ssh !== null) {
    return { failures: [`ssh: ${f.ssh}`], warnings: [], reclaim: null };
  }
  const failures: string[] = [
    ...(f.clockSkewMs === null
      ? ["clock: the host printed no time"]
      : clockFailures(f.clockSkewMs, l.clockSkewMaxMs)),
  ];
  if (f.docker === null) failures.push("docker: the daemon does not answer");
  if (!f.imagePresent) {
    failures.push("image: not on the docker host (run `frm executor image`)");
  }
  if (f.gateway !== null) failures.push(`gateway: ${f.gateway}`);
  if (f.tunnel !== null && f.tunnel !== "up") {
    failures.push("tunnel: the /mcp reverse tunnel is down");
  }
  if (f.mcp !== null && f.mcp !== EXPECTED_MCP) {
    failures.push(
      `mcp: /mcp through the gateway answered ${f.mcp}, not ${EXPECTED_MCP}`,
    );
  }
  if (f.relay !== null && f.relay !== RELAY_REFUSAL) {
    failures.push(
      `relay: POST ${RELAY_PROBE_PATH} through the gateway answered ${f.relay}, not the relay's own ${RELAY_REFUSAL}: only POST /mcp may pass (rebuild with \`frm executor image\`)`,
    );
  }
  if (f.usageError !== null) failures.push(`disk: ${f.usageError}`);
  let reclaim: string | null = null;
  const u = f.usage;
  if (u !== null) {
    const low = u.freePct < l.minFreePct;
    const over = u.usedBytes > l.quotaGb * GIB;
    if (low) {
      failures.push(
        `disk: ${round1(u.freePct)} % free, under min_free_pct ${l.minFreePct}`,
      );
    }
    if (over) {
      failures.push(
        `disk: ${round1(u.usedBytes / GIB)} GiB used, over quota_gb ${l.quotaGb}`,
      );
    }
    if (low || over) reclaim = largest(u.sessions);
  }
  return { failures, warnings: leftoverWarnings(f.leftovers), reclaim };
}

function largest(sessions: ExecutorUsage["sessions"]): string | null {
  const top = sessions.reduce<ExecutorUsage["sessions"][number] | null>(
    (best, s) =>
      s.bytes > 0 && (best === null || s.bytes > best.bytes) ? s : best,
    null,
  );
  return top?.sessionId ?? null;
}

export interface GatherDeps {
  readonly scripts: PlumbingScripts;
  readonly run: (command: string, what: string) => Promise<Ran>;
  readonly usage: () => Promise<ExecutorUsage>;
  readonly image: string;
  /** Present when this executor runs a gateway. */
  readonly ensureGateway: (() => Promise<void>) | null;
  /** This executor's build leftovers (a scan the executor reuses between checks). */
  readonly leftovers: () => Promise<BuildLeftovers>;
  /** Present when it holds a tunnel; then `mcp` names the relay's port and the API's path. */
  readonly tunnel: (() => TunnelState) | null;
  readonly mcp: { readonly port: number; readonly path: string } | null;
  readonly now: () => number;
}

const why = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/** Every check, each failure recorded rather than thrown; ssh failing first skips the rest. */
export async function gatherFacts(d: GatherDeps): Promise<HealthFacts> {
  const none = {
    clockSkewMs: null,
    docker: null,
    imagePresent: false,
    gateway: null,
    tunnel: null,
    mcp: null,
    relay: null,
    leftovers: null,
    usage: null,
    usageError: null,
  };
  let clockSkewMs: number | null;
  try {
    const t0 = d.now();
    const ran = await d.run(d.scripts.clock(), "clock");
    const remote = parseClock(ran.stdout);
    clockSkewMs =
      remote === null ? null : Math.round(remote - (t0 + d.now()) / 2);
  } catch (e) {
    return { ...none, ssh: why(e) };
  }
  let gateway: string | null = null;
  if (d.ensureGateway !== null)
    gateway = await d.ensureGateway().then(() => null, why);
  const probe = await d
    .run(
      d.scripts.health(d.image, d.tunnel === null ? null : d.mcp),
      "health probe",
    )
    .then(
      (ran) => ran.stdout,
      () => "",
    );
  const tagged = new Map(
    probe
      .split("\n")
      .map((line) => line.trim().split(/ (.*)/s))
      .map(([tag = "", rest = ""]) => [tag, rest.trim()] as const),
  );
  const docker = tagged.get("docker");
  const leftovers = await d.leftovers().then(
    (l) => l,
    () => null,
  );
  const usage = await d.usage().then(
    (u) => ({ usage: u, usageError: null }),
    (e: unknown) => ({ usage: null, usageError: why(e) }),
  );
  return {
    ssh: null,
    clockSkewMs,
    docker:
      docker === undefined || docker === "-" || docker === "" ? null : docker,
    imagePresent: tagged.get("image") === "1",
    gateway,
    tunnel: d.tunnel === null ? null : d.tunnel(),
    mcp: d.tunnel === null ? null : (tagged.get("mcp") ?? "no answer"),
    relay: d.tunnel === null ? null : (tagged.get("relay") ?? "no answer"),
    leftovers,
    ...usage,
  };
}

/** executors.health_detail: the uniform fields (core ExecutorHealthFields: the disk under
 * remote_root, the clock and the limits judged against), this kind's facts, the verdict and the
 * ssh round trip. */
export function healthDetail(
  f: HealthFacts,
  v: Verdict,
  o: {
    readonly checkedAt: number;
    readonly rttMs: number | null;
    readonly image: string;
    /** remote_root: where the disk is measured. */
    readonly root: string;
    readonly limits: ContainerHealthLimits;
    readonly reclaimed: string | null;
  },
): ExecutorHealthReport["detail"] {
  const freePct = f.usage === null ? null : round1(f.usage.freePct);
  return {
    checked_at: o.checkedAt,
    rtt_ms: o.rttMs,
    clock_skew_ms: f.clockSkewMs,
    clock_skew_max_ms: o.limits.clockSkewMaxMs,
    docker: f.docker,
    image: o.image,
    image_present: f.imagePresent,
    tunnel: f.tunnel,
    mcp: f.mcp,
    relay: f.relay,
    build_leftovers:
      f.leftovers === null
        ? null
        : {
            labelled: [...f.leftovers.labelled],
            unlabelled: [...f.leftovers.unlabelled],
            capped: f.leftovers.capped,
          },
    disk: [
      {
        path: o.root,
        free_pct: freePct,
        error: freePct === null ? (f.usageError ?? "not measured") : null,
      },
    ],
    free_pct: freePct,
    used_gb: f.usage === null ? null : round1(f.usage.usedBytes / GIB),
    min_free_pct: o.limits.minFreePct,
    quota_gb: o.limits.quotaGb,
    reclaimed: o.reclaimed,
    failures: [...v.failures],
    warnings: [...v.warnings],
  };
}
