// A check's outcome: a value to go on with, or the flag that decides the row.
// The first flag decides; nothing after it runs.
import {
  capDetail,
  type SweepFlag,
  type WorktreeKeptReason,
} from "@bayon/core";

/** The failing branch alone: assignable to every Step<T>. */
export interface Stopped {
  readonly ok: false;
  readonly flag: SweepFlag;
}

export type Step<T> = { readonly ok: true; readonly value: T } | Stopped;

export const go = <T>(value: T): Step<T> => ({ ok: true, value });

export const stop = (reason: WorktreeKeptReason, detail: string): Stopped => ({
  ok: false,
  flag: { reason, detail: capDetail(detail) },
});

/** An unexpected throw (a filesystem error) as the flag that keeps the row: never a removal. */
export const thrown = (what: string, e: unknown): Stopped =>
  stop("unverifiable", `${what}: ${String(e)}`);
