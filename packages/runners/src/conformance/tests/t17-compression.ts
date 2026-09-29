// §15 #17 context compression (spec M12): runs only when the suite runs with compression on. Two
// fixtures go into the worktree: a ~24 KB log with one `ERROR E-<code> NEEDLE-<nonce>` line in its
// middle, and a 500-item JSON array whose item 250 alone carries `TAG-<nonce>`. The runner reads both
// with its own shell and must answer the code and the tag.
//
// What it proves, through the proxy's own frames in the raw log and the store it left:
// - the proxy compressed both results in one call, and nothing failed open;
// - the error line survived compression (the code is in the answer);
// - an omitted item is recoverable (the tag is in the answer, and a tool call read the store);
// - every stored original hashes to its name, and the two fixtures are among them;
// - re-sends are byte-stable (each call's compressed digests start with the previous call's);
// - the mapper folded the frames into the run's terminal.
import { randomBytes, randomInt } from "node:crypto";
import { join } from "node:path";
import {
  mentionsContextStore,
  parseContextFrame,
  type ContextFrame,
} from "@bayon/core";
import type { StoredEvent } from "../types.js";
import { check, define, terminalPayload, runnerTerminals } from "./define.js";

export const CTX_LOG_FILE = "frm-ctx.log";
export const CTX_JSON_FILE = "frm-ctx.json";
const LOG_LINES = 400;
const JSON_ITEMS = 500;
const TAGGED_ITEM = 250;

const pad = (n: number): string => String(n).padStart(2, "0");

/** ~24 KB of similar lines, one error line in the middle carrying `code`. */
export function contextLog(code: string, nonce: string): string {
  const lines = Array.from({ length: LOG_LINES }, (_, i) => {
    const at = `2026-09-26T10:${pad(Math.floor(i / 60))}:${pad(i % 60)}Z`;
    return i === LOG_LINES / 2
      ? `${at} ERROR ${code} NEEDLE-${nonce} the upstream refused batch ${i}`
      : `${at} INFO worker-${i % 4} processed batch ${i} in ${10 + ((i * 7) % 90)} ms`;
  });
  return `${lines.join("\n")}\n`;
}

/** A JSON array of like items; item 250 alone carries `tag`, so the rules omit it. */
export function contextJson(tag: string): string {
  const items = Array.from({ length: JSON_ITEMS }, (_, i) => ({
    id: i,
    name: `item-${i}`,
    tag: i === TAGGED_ITEM ? tag : `t-${i}`,
  }));
  return `${JSON.stringify(items)}\n`;
}

export interface CompressionEvidence {
  readonly code: string;
  readonly tag: string;
  readonly log: string;
  readonly json: string;
  /** Everything the runner said in the run. */
  readonly answer: string;
  /** Whether a tool call's input named the store. */
  readonly readStore: boolean;
  /** The proxy's frames, in raw-log order. */
  readonly frames: readonly ContextFrame[];
  /** The run's runner terminal's `context`, as stored. */
  readonly context: unknown;
  /** Each stored original: its file name, its content's sha256, its text. */
  readonly store: readonly {
    readonly name: string;
    readonly digest: string;
    readonly text: string;
  }[];
}

const decoder = new TextDecoder();

/** The raw log's `frm.ctx` frames that parse; anything else in it is the runner's. */
export function framesOf(raw: Uint8Array): readonly ContextFrame[] {
  return decoder
    .decode(raw)
    .split("\n")
    .flatMap((line) => {
      if (!line.includes('"frm.ctx"')) return [];
      try {
        const frame = parseContextFrame(JSON.parse(line) as unknown);
        return frame.ok ? [frame.value] : [];
      } catch {
        return [];
      }
    });
}

const startsWith = (a: readonly string[], prefix: readonly string[]) =>
  prefix.every((d, i) => a[i] === d);

/** Each call's compressed digests start with the previous call's (calls with none skipped). */
export function stableDigests(frames: readonly ContextFrame[]): boolean {
  const lists = frames.map((f) => f.digests).filter((d) => d.length > 0);
  return lists.every((d, i) => i === 0 || startsWith(d, lists[i - 1] ?? []));
}

const answerOf = (events: readonly StoredEvent[]): string =>
  events
    .flatMap((e) => (e.kind === "assistant_text" ? [e.text] : []))
    .join("\n");

const touchesStore = (events: readonly StoredEvent[]): boolean =>
  events.some(
    (e) =>
      (e.kind === "tool_call" || e.kind === "command") &&
      mentionsContextStore(JSON.stringify(e.payload)),
  );

export function judgeCompression(e: CompressionEvidence) {
  const most = Math.max(0, ...e.frames.map((f) => f.compressed));
  const failed = e.frames.reduce((n, f) => n + f.failed, 0);
  const named = e.store.filter(
    (s) => s.name === `${s.digest}.txt` && /^[0-9a-f]{64}\.txt$/.test(s.name),
  );
  const holds = (fixture: string) =>
    e.store.some((s) => s.text.includes(fixture.trim()));
  const context = e.context as { compressed?: unknown } | undefined;
  return [
    check(
      "compressed",
      most >= 2,
      `${most} block(s) compressed in one call, over ${e.frames.length} call(s)`,
      { precondition: true },
    ),
    check("none_failed_open", failed === 0, `${failed} block(s) failed open`),
    check(
      "error_line_kept",
      e.answer.includes(e.code),
      e.answer.includes(e.code)
        ? "the error code is in the answer"
        : "the answer lacks the error code",
    ),
    check(
      "tag_recovered",
      e.answer.includes(e.tag) && e.readStore,
      `tag in the answer: ${String(e.answer.includes(e.tag))}; a tool call read the store: ${String(e.readStore)}`,
    ),
    check(
      "store_intact",
      e.store.length > 0 &&
        named.length === e.store.length &&
        holds(e.log) &&
        holds(e.json),
      `${named.length} of ${e.store.length} original(s) hash to their name; log stored: ${String(holds(e.log))}; json stored: ${String(holds(e.json))}`,
    ),
    check(
      "resends_stable",
      stableDigests(e.frames),
      stableDigests(e.frames)
        ? "each call's compressed blocks start with the previous call's"
        : "a call's compressed blocks differ from the previous call's",
    ),
    check(
      "terminal_context",
      typeof context?.compressed === "number" && context.compressed >= 2,
      context === undefined
        ? "the run's terminal has no context"
        : `the terminal's context counts ${String(context.compressed)} compressed`,
    ),
  ];
}

export const t17 = define({
  id: 17,
  retries: 1,
  drive: async (ctx): Promise<CompressionEvidence> => {
    const { ingest, workspace } = ctx.ports;
    const nonce = randomBytes(6).toString("hex");
    const code = `E-${randomInt(10_000, 100_000)}`;
    const tag = `TAG-${nonce}`;
    const log = contextLog(code, nonce);
    const json = contextJson(tag);
    const live = await ctx.open({
      scenario: "compression",
      compression: { nonce, logFile: CTX_LOG_FILE, jsonFile: CTX_JSON_FILE },
      files: { [CTX_LOG_FILE]: log, [CTX_JSON_FILE]: json },
    });
    await live.spawn();
    const end = await live.run(live.turn(0));
    const storeDir = live.spec.contextCompression?.storeDir;
    const listed =
      storeDir === undefined
        ? new Map<string, string>()
        : await ctx.harness("workspace", workspace.snapshot(storeDir));
    const store = [];
    for (const [name, digest] of listed) {
      const text = await ctx.harness(
        "workspace",
        workspace.read(join(storeDir ?? "", name)),
      );
      store.push({ name, digest, text: text ?? "" });
    }
    const [terminal] = runnerTerminals(end.events);
    return {
      code,
      tag,
      log,
      json,
      answer: answerOf(end.events),
      readStore: touchesStore(end.events),
      frames: framesOf(await ingest.raw(live.sessionId)),
      context:
        terminal === undefined
          ? undefined
          : terminalPayload(terminal)?.["context"],
      store,
    };
  },
  judge: judgeCompression,
});
