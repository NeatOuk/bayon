import { GateEvidence, type Result } from "@bayon/core";
import {
  WireError,
  type FindingView,
  type GateView,
  type RunnerConformanceResult,
  type RunnerView,
  type TicketDetail,
} from "@bayon/proto";
import { z } from "zod";
import { HttpCause } from "./api-client.js";

// The M3 smoke's pure checks (plan "M3 — Acceptance"). Each returns what is wrong, as sentences;
// an empty list passes. Inputs are the API's own views, as the operator reads them.

/** A ticket's gates of `kind`, oldest attempt first. */
export const attemptsOf = (
  gates: readonly GateView[],
  kind: string,
): GateView[] =>
  gates
    .filter((g) => g.kind === kind)
    .toSorted((a, b) => a.attempt - b.attempt);

const label = (g: GateView): string => `${g.kind} attempt ${g.attempt}`;

/**
 * Step 1: the suite's result stored a certification on `executorId`, nothing failed or was left
 * incomplete, its report is on disk, and GET /runners shows the pair gate-eligible and passed.
 */
export function conformanceProblems(
  r: RunnerConformanceResult,
  view: RunnerView | undefined,
  executorId: string,
  reportExists: boolean,
): string[] {
  const s = r.summary;
  const who = `${r.runner_id} on ${executorId}`;
  // Per model: the certificate of the model this run was for, with its compression
  //: a compression-on row of the same model is another certificate.
  const cert = view?.certifications.find(
    (c) =>
      c.executor_id === executorId &&
      c.model_id === r.model_id &&
      c.compression === r.compression,
  );
  const listed =
    view === undefined
      ? [`GET /runners has no ${r.runner_id}`]
      : cert === undefined
        ? [
            `GET /runners: ${who} has no certification of model ${r.model_id ?? "none"}`,
          ]
        : [
            ...(cert.gate_eligible
              ? []
              : [`GET /runners: ${who} is not gate_eligible`]),
            ...(cert.passed_at === null
              ? [`GET /runners: ${who} has no passed_at`]
              : []),
            ...(cert.decertified_at === null
              ? []
              : [
                  `GET /runners: ${who} is decertified: ${cert.decertified_reason ?? "no reason"}`,
                ]),
          ];
  return [
    ...(r.executor_id === executorId
      ? []
      : [`${r.runner_id} ran on ${r.executor_id}, not ${executorId}`]),
    ...(r.stored ? [] : [`${who}: nothing stored, the run is not certifiable`]),
    ...(s.gate_eligible ? [] : [`${who}: the result is not gate-eligible`]),
    ...(s.failed.length === 0 ? [] : [`${who} failed ${s.failed.join(", ")}`]),
    ...(s.incomplete.length === 0
      ? []
      : [`${who} left ${s.incomplete.join(", ")} incomplete`]),
    ...(reportExists ? [] : [`${who}: no report at ${r.report_path}`]),
    ...listed,
  ];
}

/** A decided gate: its state, and the reason it failed (null for a pass). */
export function gateProblems(
  g: GateView | undefined,
  at: { readonly kind: string; readonly attempt: number },
  want: { readonly state: string; readonly reason: string | null },
): string[] {
  if (g === undefined) return [`no ${at.kind} attempt ${at.attempt}`];
  const why = g.reason === null ? "" : ` (${g.reason})`;
  return [
    ...(g.state === want.state
      ? []
      : [`${label(g)} is ${g.state}${why}, expected ${want.state}`]),
    ...(g.state !== want.state || g.reason === want.reason
      ? []
      : [
          `${label(g)} gives the reason ${g.reason ?? "none"}, expected ${want.reason ?? "none"}`,
        ]),
  ];
}

export interface EvidenceWant {
  readonly runnerId: string;
  readonly executorId: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly findings: number;
  readonly parse: "schema" | "heuristic";
  readonly singleRunner: boolean;
}

/**
 * §10.3 evidence on a gate: every field present (core GateEvidence), the reviewer exited 0, and
 * it names the reviewer, the session, the pinned range and the findings the smoke expects.
 */
export function evidenceProblems(g: GateView, want: EvidenceWant): string[] {
  const parsed = GateEvidence.safeParse(g.evidence);
  if (!parsed.success) {
    return [
      `${label(g)}'s evidence is incomplete: ${z.prettifyError(parsed.error)}`,
    ];
  }
  const e = parsed.data;
  const single = e.flags.single_runner_review === true;
  const range = `${e.subject.base_sha}..${e.subject.head_sha}`;
  const wantRange = `${want.baseSha}..${want.headSha}`;
  return [
    ...(e.exit_code === 0
      ? []
      : [`${label(g)}: the reviewer exited ${e.exit_code}`]),
    ...(e.runner_id === want.runnerId
      ? []
      : [`${label(g)} was reviewed by ${e.runner_id}, not ${want.runnerId}`]),
    ...(e.executor_id === want.executorId
      ? []
      : [`${label(g)} ran on ${e.executor_id}, not ${want.executorId}`]),
    ...(e.session_id === g.session_id
      ? []
      : [
          `${label(g)}'s evidence names session ${e.session_id}, the gate ${g.session_id ?? "none"}`,
        ]),
    ...(range === wantRange
      ? []
      : [`${label(g)} reviewed ${range}, not ${wantRange}`]),
    ...(e.findings.total === want.findings
      ? []
      : [
          `${label(g)}'s evidence counts ${e.findings.total} finding(s), expected ${want.findings}`,
        ]),
    ...(e.findings.parse === want.parse
      ? []
      : [`${label(g)} was parsed ${e.findings.parse}, not ${want.parse}`]),
    ...(single === want.singleRunner
      ? []
      : [
          `${label(g)}: flags.single_runner_review is ${single}, expected ${want.singleRunner}`,
        ]),
  ];
}

/** Round 1's code_review: exactly one finding, open, at `severity`, on `file`. */
export function blockingProblems(
  g: GateView,
  want: { readonly severity: string; readonly file: string },
): string[] {
  return [
    ...(g.findings.length === 1
      ? []
      : [
          `${label(g)} has ${g.findings.length} finding(s), expected exactly 1`,
        ]),
    ...(g.findings_unresolved === 1
      ? []
      : [`${label(g)} counts ${g.findings_unresolved} unresolved, expected 1`]),
    ...g.findings.flatMap((f) => [
      ...(f.severity === want.severity
        ? []
        : [`finding ${f.id} is ${f.severity}, expected ${want.severity}`]),
      ...(f.status === "open"
        ? []
        : [`finding ${f.id} is ${f.status}, expected open`]),
      ...(f.file === want.file
        ? []
        : [`finding ${f.id} is on ${f.file ?? "no file"}, not ${want.file}`]),
    ]),
  ];
}

export interface RefusalWant {
  readonly status: number;
  readonly rule: string;
  readonly reason: string;
}

/** A REST transition the laws refused: its HTTP status, rule and reason (M1 contract 2). */
export function refusalProblems(
  r: Result<unknown>,
  want: RefusalWant,
): string[] {
  if (r.ok) {
    return [`${want.rule} was allowed; expected ${want.status} ${want.reason}`];
  }
  const cause = HttpCause.safeParse(r.error.cause);
  const wire = WireError.safeParse(r.error);
  const status = cause.success ? String(cause.data.status) : "no status";
  const got = wire.success
    ? `${wire.data.rule ?? "no rule"} / ${wire.data.reason ?? "no reason"}`
    : "an unreadable error";
  return [
    ...(cause.success && cause.data.status === want.status
      ? []
      : [`${want.rule} answered ${status}, expected ${want.status}`]),
    ...(wire.success &&
    wire.data.rule === want.rule &&
    wire.data.reason === want.reason
      ? []
      : [
          `${want.rule} was refused ${got}, expected ${want.rule} / ${want.reason}: ${r.error.message}`,
        ]),
  ];
}

/** Step 4: the finding is resolved, by the fixing session, naming its run and a note. */
export function resolvedProblems(
  f: FindingView | undefined,
  want: { readonly runId: string; readonly sessionId: string },
): string[] {
  if (f === undefined) return ["the round-1 finding is gone"];
  return [
    ...(f.status === "resolved"
      ? []
      : [`finding ${f.id} is ${f.status}, expected resolved`]),
    ...(f.resolved_by_run_id === want.runId
      ? []
      : [
          `finding ${f.id} names run ${f.resolved_by_run_id ?? "none"}, not the fixing run ${want.runId}`,
        ]),
    ...((f.resolved_by ?? "").includes(want.sessionId)
      ? []
      : [
          `finding ${f.id} was resolved by ${f.resolved_by ?? "nobody"}, not session ${want.sessionId}`,
        ]),
    ...((f.resolution_note ?? "").trim() === ""
      ? [`finding ${f.id} has no resolution note`]
      : []),
  ];
}

/** Step 6: the round count comes from the view (amendment b). */
export const roundsProblems = (d: TicketDetail, want: number): string[] =>
  d.economics.review_rounds === want
    ? []
    : [`review_rounds is ${d.economics.review_rounds}, expected ${want}`];

/** Step 6: every artifact path each gate's evidence lists is on disk; there is some evidence. */
export function artifactProblems(
  gates: readonly GateView[],
  exists: (path: string) => boolean,
): string[] {
  const listed = gates.flatMap((g) => {
    const e = GateEvidence.safeParse(g.evidence);
    return e.success ? [{ g, paths: e.data.artifact_paths }] : [];
  });
  return [
    ...(listed.length === 0 ? ["no gate carries evidence"] : []),
    ...listed.flatMap(({ g, paths }) =>
      paths
        .filter((path) => !exists(path))
        .map((path) => `${label(g)}: ${path} does not exist`),
    ),
  ];
}

/**
 * Step 8: attempt 1 timed out; decideGate opened attempt 2 as it decided (same kind, next
 * number); attempt 2 timed out too and, gates.timeout_retries being 1, nothing followed it.
 */
export function retryProblems(attempts: readonly GateView[]): string[] {
  const [first, second, ...more] = attempts;
  const kind = first?.kind ?? "gate";
  const timedOut = { state: "failed", reason: "timeout" } as const;
  return [
    ...gateProblems(first, { kind, attempt: 1 }, timedOut),
    ...(second === undefined
      ? [`no ${kind} attempt 2: the timeout was not retried`]
      : [
          ...(second.attempt === 2
            ? []
            : [`the retry is attempt ${second.attempt}, expected 2`]),
          ...(first !== undefined &&
          first.decided_at !== null &&
          (second.started_at ?? 0) < first.decided_at
            ? ["attempt 2 started before attempt 1 was decided"]
            : []),
          ...gateProblems(second, { kind, attempt: 2 }, timedOut),
        ]),
    ...(more.length === 0
      ? []
      : [
          `${more.length} attempt(s) after the retry: one retry is the budget (gates.timeout_retries)`,
        ]),
  ];
}
