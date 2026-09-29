// What every conformance test is: a drive (effects → evidence) and a pure judge (evidence →
// named checks), plus the helpers the judges share. Runner-neutral.
import {
  FrmError,
  clipDetail,
  type ConformanceTestId,
  type RunOutcome,
  type RunnerCaps,
} from "@bayon/core";
import type { SuiteCtx } from "../harness.js";
import type { Check, ConformanceKit, StoredEvent } from "../types.js";
import type { ExecutorKind } from "@bayon/executors";

/** `cap`: the gating cap is declared (or there is none). `fallback`: it is declared absent. */
export type Branch = "cap" | "fallback";

export interface TestDef<E> {
  readonly id: ConformanceTestId;
  /** 1 for model-dependent tests: one retry when only a precondition failed. */
  readonly retries: 0 | 1;
  /** What an N/A verified instead, for the report. */
  fallback?(caps: RunnerCaps): string;
  /**
   * The kit declares the runner refuses what this test drives, so the fallback branch runs
   * instead (§15 #16, core DECLARED_NA). Only a test core allows a declared N/A may have one,
   * and the branch must still produce checks that hold: the refusal is verified, not believed.
   */
  declaredFallback?(kit: ConformanceKit, executorKind: ExecutorKind): boolean;
  drive(ctx: SuiteCtx, branch: Branch, attempt: number): Promise<E>;
  judge(e: E, branch: Branch, caps: RunnerCaps): readonly Check[];
}

export interface ConformanceTest {
  readonly id: ConformanceTestId;
  readonly retries: 0 | 1;
  fallback(caps: RunnerCaps): string | undefined;
  declaredFallback(kit: ConformanceKit, executorKind: ExecutorKind): boolean;
  run(
    ctx: SuiteCtx,
    branch: Branch,
    attempt: number,
  ): Promise<readonly Check[]>;
}

export function define<E>(t: TestDef<E>): ConformanceTest {
  return {
    id: t.id,
    retries: t.retries,
    fallback: (caps) => t.fallback?.(caps),
    declaredFallback: (kit, kind) => t.declaredFallback?.(kit, kind) ?? false,
    run: async (ctx, branch, attempt) =>
      t.judge(await t.drive(ctx, branch, attempt), branch, ctx.caps),
  };
}

/** The suite's clip is core's: a certification's pins are read back through the same cut. */
export const clip = clipDetail;

export function check(
  name: string,
  ok: boolean,
  detail: string | null = null,
  o: { readonly precondition?: boolean } = {},
): Check {
  return {
    name,
    ok,
    detail: detail === null ? null : clip(detail),
    ...(o.precondition === true ? { precondition: true } : {}),
  };
}

/** Terminals the runner itself sent, including any the ingest demoted as late (first wins). */
export const runnerTerminals = (
  events: readonly StoredEvent[],
): readonly StoredEvent[] =>
  events.filter(
    (e) =>
      e.source === "runner" &&
      (e.kind === "terminal" ||
        (e.kind === "runner_native" &&
          e.payload["demoted_kind"] === "terminal")),
  );

/** A terminal's payload, whether stored as the run's terminal or demoted as a late one. */
export function terminalPayload(
  e: StoredEvent,
): Readonly<Record<string, unknown>> | undefined {
  if (e.kind === "terminal") return e.payload;
  if (e.kind !== "runner_native" || e.payload["demoted_kind"] !== "terminal")
    return undefined;
  const raw = e.payload.raw;
  return typeof raw === "object" && raw !== null
    ? (raw as Readonly<Record<string, unknown>>)
    : undefined;
}

/**
 * §5.2 amendment: after its own logged interrupt is followed by an observed
 * process end, an adapter may write `terminal{interrupted}` itself, marked with this basis. It never
 * reads the exit code for it, and never synthesizes ok or failed.
 */
export const INTERRUPT_EXIT_BASIS = "interrupt+exit";

export function isInterruptExit(e: StoredEvent): boolean {
  const p = terminalPayload(e);
  return (
    p?.["outcome"] === "interrupted" && p["basis"] === INTERRUPT_EXIT_BASIS
  );
}

/** Exactly one runner terminal, and it carries `outcome`. */
export function endedWith(
  events: readonly StoredEvent[],
  outcome: RunOutcome,
): boolean {
  const terminals = runnerTerminals(events);
  const [only] = terminals;
  return (
    terminals.length === 1 &&
    only?.kind === "terminal" &&
    only.payload.outcome === outcome
  );
}

/** How much of a terminal error's message a check detail carries. */
export const ERROR_MESSAGE_CHARS = 120;

/** An adapter's kind of error (`cause.kind`), when it is a short word. */
const KIND = /^[a-z][a-z0-9_]{0,23}$/;

/**
 * A terminal's error as a check detail reads it: its class, the adapter's kind, and its
 * message flattened to one line and cut. The error alone — no other payload text. The message is
 * already redacted: ingest scrubs the session's secrets from each record before it is mapped
 * (Invariant 11), so what reaches the event is what the raw log holds.
 */
function errorOf(payload: Readonly<Record<string, unknown>>): string | null {
  const parsed = FrmError.safeParse(payload["error"]);
  if (!parsed.success) return null;
  const { class: cls, message, cause } = parsed.data;
  const kind =
    typeof cause === "object" && cause !== null && "kind" in cause
      ? cause.kind
      : undefined;
  const named =
    typeof kind === "string" && KIND.test(kind) ? `${cls}/${kind}` : cls;
  const flat = message.replace(/\s+/g, " ").trim();
  const cut =
    flat.length <= ERROR_MESSAGE_CHARS
      ? flat
      : `${flat.slice(0, ERROR_MESSAGE_CHARS - 1)}…`;
  return cut === "" ? named : `${named}: ${cut}`;
}

/**
 * "runner:ok", "supervisor:timeout" or "no terminal": for check details. A terminal that carries an
 * error adds it: "runner:failed (runner_error: model … not found)".
 */
export function outcomeOf(events: readonly StoredEvent[]): string {
  const t = events.find((e) => e.kind === "terminal");
  if (t?.kind !== "terminal") return "no terminal";
  const outcome = `${t.source}:${t.payload.outcome}`;
  const error = errorOf(t.payload);
  return error === null ? outcome : `${outcome} (${error})`;
}

export const callIds = (
  events: readonly StoredEvent[],
  kind: "tool_call" | "tool_result",
): readonly string[] =>
  events.flatMap((e) => (e.kind === kind ? [String(e.payload.call_id)] : []));

export const sameIds = (
  a: readonly string[],
  b: readonly string[],
): boolean => {
  const x = a.toSorted();
  const y = b.toSorted();
  return x.length === y.length && x.every((id, i) => id === y[i]);
};
