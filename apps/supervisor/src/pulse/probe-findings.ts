// What a probe check keeps in its row (§10.2, §8.5): findings, each with the fingerprint that
// dedupes the ticket filed for it, serialized within the tool-result cap. What does not fit is
// counted in the row and kept whole on disk by the caller.
import { createHash } from "node:crypto";
import type { JsonValue } from "@bayon/core";
import { TOOL_RESULT_MAX_BYTES, TOOL_RESULT_MAX_LINES } from "../ingest/cap.js";

/** Findings a row keeps at most; the rest are counted (`omitted`) and left in the full file. */
export const MAX_FINDINGS = 50;
/** A shell finding shows at most this much of its line. */
export const LINE_CHARS = 240;

/** A finding's fingerprint (§10.2): its probe and subject, hashed to 16 hex characters. */
export const fingerprintOf = (probe: string, subject: string): string =>
  createHash("sha256")
    .update(`${probe}\n${subject}`)
    .digest("hex")
    .slice(0, 16);

/** A line's signature: digit runs (times, pids, line numbers, counters) collapse, so repeats of
 * one message share it. */
export const signatureOf = (line: string): string => line.replace(/\d+/g, "#");

export const clip = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/** Over the tool-result cap: 8 KB or 200 lines. */
export const overCap = (text: string): boolean =>
  Buffer.byteLength(text, "utf8") > TOOL_RESULT_MAX_BYTES ||
  text.split("\n").length > TOOL_RESULT_MAX_LINES;

/** A type, not an interface, so it is assignable to JsonValue. */
export type LineFinding = {
  readonly fingerprint: string;
  /** The first line with this signature, clipped. */
  readonly line: string;
  /** How many lines share the signature. */
  readonly count: number;
};

/** A shell probe's output as findings: one per distinct signature, first seen first. */
export function lineFindings(probe: string, text: string): LineFinding[] {
  const seen = new Map<
    string,
    { readonly line: string; readonly count: number }
  >();
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const signature = signatureOf(line);
    const prior = seen.get(signature);
    seen.set(
      signature,
      prior === undefined
        ? { line, count: 1 }
        : { ...prior, count: prior.count + 1 },
    );
  }
  return [...seen].map(([signature, { line, count }]) => ({
    fingerprint: fingerprintOf(probe, signature),
    line: clip(line, LINE_CHARS),
    count,
  }));
}

export interface Fitted {
  readonly json: string;
  /** Findings left out of `json`. */
  readonly omitted: number;
}

/**
 * `{...head, findings}` as JSON within 8 KB: at most MAX_FINDINGS, and fewer while it does not
 * fit. `omitted` counts what was left out, and is in the JSON too when non-zero.
 */
export function fitResult(
  head: { readonly [key: string]: JsonValue },
  findings: readonly JsonValue[],
): Fitted {
  const render = (kept: number): Fitted => {
    const omitted = findings.length - kept;
    const json = JSON.stringify({
      ...head,
      findings: findings.slice(0, kept),
      ...(omitted > 0 ? { omitted } : {}),
    });
    return { json, omitted };
  };
  let kept = Math.min(findings.length, MAX_FINDINGS);
  let fitted = render(kept);
  while (
    kept > 0 &&
    Buffer.byteLength(fitted.json, "utf8") > TOOL_RESULT_MAX_BYTES
  ) {
    kept -= 1;
    fitted = render(kept);
  }
  return fitted;
}
