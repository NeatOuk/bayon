import { createHash } from "node:crypto";
import type {
  EventItem,
  ExecutorView,
  RunnerConformanceResult,
} from "@bayon/proto";
import { z } from "zod";

// The M3 container run's pure checks (plan "M3 — Container run"). Each returns what is wrong, as
// sentences; an empty list passes.

/** The session runs on this run's executor: a `ctr:<executor id>:` ref. */
export function refProblems(ref: string | null, executorId: string): string[] {
  return ref !== null && ref.startsWith(`ctr:${executorId}:`)
    ? []
    : [`executor_ref ${ref ?? "none"} does not start with ctr:${executorId}:`];
}

const Detail = z.looseObject({
  tunnel: z.string().nullable().optional(),
  mcp: z.string().nullable().optional(),
  failures: z.array(z.string()).optional(),
});

/** Healthy, the /mcp tunnel up, and /mcp answering 401 (no bearer) through the gateway. */
export function healthProblems(v: ExecutorView | undefined): string[] {
  if (v === undefined) return ["GET /executors does not list the executor"];
  const d = Detail.safeParse(v.health_detail ?? {});
  const detail = d.success ? d.data : {};
  return [
    ...(v.health === "healthy"
      ? []
      : [
          `the executor is ${v.health}: ${(detail.failures ?? []).join("; ") || "no detail"}`,
        ]),
    ...(detail.tunnel === "up"
      ? []
      : [`the /mcp tunnel is ${detail.tunnel ?? "not reported"}`]),
    ...(detail.mcp === "401"
      ? []
      : [
          `/mcp through the gateway answered ${detail.mcp ?? "nothing"}, not 401`,
        ]),
  ];
}

/**
 * The session's MCP call came back (status ok): its initialize and tools/call went from the
 * container through the gateway and the reverse tunnel to the API and back.
 */
export function mcpRoundTripProblems(
  events: readonly EventItem[],
  tool: string,
): string[] {
  const calls = events.filter(
    (e) => e.kind === "mcp_call" && e.tool_name === tool,
  );
  if (calls.length === 0) return [`no ${tool} mcp_call in the session`];
  return calls.some((c) => c.status === "ok")
    ? []
    : [
        `${tool}'s mcp_call did not come back: ${calls.map((c) => c.status ?? "?").join(", ")}`,
      ];
}

/** `docker inspect` of this run's containers: the session's is among them; no canary anywhere. */
export function inspectProblems(
  json: string,
  canary: string,
  sessionContainers: readonly string[],
): string[] {
  let ids: string[] = [];
  try {
    const parsed = z
      .array(z.looseObject({ Id: z.string() }))
      .safeParse(JSON.parse(json));
    ids = parsed.success ? parsed.data.map((c) => c.Id) : [];
  } catch {
    return ["docker inspect did not print JSON"];
  }
  const missing = sessionContainers.filter(
    (c) => !ids.some((id) => id.startsWith(c) || c.startsWith(id)),
  );
  return [
    ...(ids.length === 0 ? ["docker inspect listed no container"] : []),
    ...missing.map((c) => `docker inspect did not cover ${c.slice(0, 12)}`),
    ...(json.includes(canary) ? ["the canary is in docker inspect"] : []),
  ];
}

/** The canary (or anything) found in files where it must never be. */
export const noFilesProblems = (
  where: string,
  files: readonly string[],
): string[] =>
  files.length === 0
    ? []
    : [`the canary is on ${where}: ${files.slice(0, 5).join(", ")}`];

/** Text (a raw log) that must not hold the canary. */
export const absentProblems = (
  where: string,
  text: string,
  canary: string,
): string[] => (text.includes(canary) ? [`the canary is in ${where}`] : []);

/** The canary's sha-256: what the stand-in records when a secret reaches it. */
export const digestOf = (canary: string): string =>
  createHash("sha256").update(canary).digest("hex");

/** Positive control: the secret did reach the runner in the container (its digest is there). */
export const reachedProblems = (files: readonly string[]): string[] =>
  files.length > 0
    ? []
    : [
        "no file in the session's root carries the canary's digest: the secret never reached the runner, so its absence proves nothing",
      ];

export interface EgressSeen {
  readonly allowed: string;
  readonly refused: string;
  readonly direct: string;
}

/** Through the gateway: the allowed host 200, another 403; with no proxy, no route out. */
export function egressProblems(
  seen: EgressSeen,
  hosts: { readonly allowed: string; readonly refused: string },
): string[] {
  return [
    ...(seen.allowed === `CONNECT ${hosts.allowed} 200`
      ? []
      : [`the allowed host: ${seen.allowed || "no answer"}`]),
    ...(seen.refused === `CONNECT ${hosts.refused} 403`
      ? []
      : [`the disallowed host: ${seen.refused || "no answer"}, not a 403`]),
    ...(/^DIRECT (error|timeout)/.test(seen.direct)
      ? []
      : [`a direct connection: ${seen.direct || "no answer"}, not refused`]),
  ];
}

/** The host after teardown: nothing of this run left, unlabelled containers exactly as before. */
export function cleanProblems(
  left: Readonly<Record<string, string>>,
  before: readonly string[],
  after: readonly string[],
): string[] {
  const counts = ["containers", "networks", "images", "volumes"]
    .filter((k) => left[k] !== "0")
    .map((k) => `${left[k] ?? "?"} labelled ${k} left`);
  const gone = before.filter((id) => !after.includes(id));
  return [
    ...counts,
    ...(left["root"] === "gone" ? [] : ["the remote root is left"]),
    ...(gone.length === 0
      ? []
      : [`${gone.length} unlabelled container(s) went missing`]),
  ];
}

/** Conformance on the container: its report, and test 11 (MCP round-trip) passing through the tunnel. */
export function conformance11Problems(
  r: RunnerConformanceResult,
  executorId: string,
): string[] {
  return [
    ...(r.executor_id === executorId
      ? []
      : [`the suite ran on ${r.executor_id}, not ${executorId}`]),
    ...(r.summary.passed.includes(11)
      ? []
      : [
          `test 11 (MCP round-trip) did not pass on ${executorId}: ${
            r.summary.failed.includes(11)
              ? "failed"
              : r.summary.incomplete.includes(11)
                ? "incomplete"
                : "not run"
          }`,
        ]),
    ...(r.stored && r.summary.gate_eligible
      ? []
      : [
          `the pair is not certified gate-eligible (incomplete: ${r.summary.incomplete.join(", ") || "none"}; failed: ${r.summary.failed.join(", ") || "none"})`,
        ]),
  ];
}
