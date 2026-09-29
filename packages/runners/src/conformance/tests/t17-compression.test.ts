// Test 17's judge and its evidence helpers (spec M12): each check fails on the one thing it
// guards, and the fixtures are what the rules must work on (over the cap, the tag omitted, the error
// line kept).
import { createHash } from "node:crypto";
import {
  CONTEXT_RULESET,
  compressToolResult,
  type ContextFrame,
} from "@bayon/core";
import { expect, test } from "vitest";
import {
  contextJson,
  contextLog,
  framesOf,
  judgeCompression,
  stableDigests,
  type CompressionEvidence,
} from "./t17-compression.js";

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const LOG = contextLog("E-4242", "abc123");
const JSON_TEXT = contextJson("TAG-abc123");

const frame = (
  digests: string[],
  o: Partial<ContextFrame> = {},
): ContextFrame => ({
  type: "frm.ctx",
  v: 1,
  ruleset: CONTEXT_RULESET,
  blocks: digests.length,
  compressed: digests.length,
  failed: 0,
  chars_in: 100,
  chars_out: 10,
  digests,
  ms: 1,
  ...o,
});

const GOOD: CompressionEvidence = {
  code: "E-4242",
  tag: "TAG-abc123",
  log: LOG,
  json: JSON_TEXT,
  answer: "E-4242 TAG-abc123",
  readStore: true,
  frames: [
    frame([]),
    frame([sha(LOG), sha(JSON_TEXT)]),
    frame([sha(LOG), sha(JSON_TEXT)]),
  ],
  context: { compressed: 4 },
  store: [
    { name: `${sha(LOG)}.txt`, digest: sha(LOG), text: LOG },
    { name: `${sha(JSON_TEXT)}.txt`, digest: sha(JSON_TEXT), text: JSON_TEXT },
  ],
};

const failing = (e: CompressionEvidence) =>
  judgeCompression(e)
    .filter((c) => !c.ok)
    .map((c) => c.name);

test("the fixtures are what the rules must work on", () => {
  const log = compressToolResult(LOG, {
    originalPath: "/w/.foreman/ctx/a.txt",
  });
  const json = compressToolResult(JSON_TEXT, {
    originalPath: "/w/.foreman/ctx/b.txt",
  });
  expect(log.kind).toBe("compressed");
  expect(json.kind).toBe("compressed");
  expect(log.kind === "compressed" ? log.text : "").toContain(
    "ERROR E-4242 NEEDLE-abc123",
  );
  expect(json.kind === "compressed" ? json.text : "TAG-abc123").not.toContain(
    "TAG-abc123",
  );
  expect(Buffer.byteLength(LOG)).toBeGreaterThan(20_000);
  expect(Buffer.byteLength(LOG)).toBeLessThan(30_000); // under the CLI's own shell-output cut
  expect(Buffer.byteLength(JSON_TEXT)).toBeLessThan(30_000);
});

test("a run that did it all passes every check", () => {
  expect(failing(GOOD)).toEqual([]);
});

test("each check fails on what it guards", () => {
  expect(failing({ ...GOOD, frames: [frame([sha(LOG)])] })).toEqual(
    expect.arrayContaining(["compressed"]),
  );
  expect(
    failing({
      ...GOOD,
      frames: [...GOOD.frames, frame([], { blocks: 1, failed: 1 })],
    }),
  ).toEqual(["none_failed_open"]);
  expect(failing({ ...GOOD, answer: "TAG-abc123" })).toEqual([
    "error_line_kept",
  ]);
  expect(failing({ ...GOOD, readStore: false })).toEqual(["tag_recovered"]);
  expect(failing({ ...GOOD, answer: "E-4242" })).toEqual(["tag_recovered"]);
  expect(
    failing({
      ...GOOD,
      store: [
        {
          ...(GOOD.store[0] ?? { name: "", digest: "", text: "" }),
          digest: "0".repeat(64),
        },
      ],
    }),
  ).toEqual(["store_intact"]);
  expect(failing({ ...GOOD, store: [] })).toEqual(["store_intact"]);
  expect(
    failing({
      ...GOOD,
      frames: [
        frame([sha(LOG), sha(JSON_TEXT)]),
        frame([sha(JSON_TEXT), sha(LOG)]),
      ],
    }),
  ).toEqual(["resends_stable"]);
  expect(failing({ ...GOOD, context: undefined })).toEqual([
    "terminal_context",
  ]);
  expect(failing({ ...GOOD, context: { compressed: 1 } })).toEqual([
    "terminal_context",
  ]);
});

test("only the compressed check lets a model-dependent run retry", () => {
  const checks = judgeCompression({ ...GOOD, frames: [] });
  expect(
    checks.filter((c) => c.precondition === true).map((c) => c.name),
  ).toEqual(["compressed"]);
});

test("frames come out of the raw log; the runner's own lines and bad frames do not", () => {
  const good = frame(["a".repeat(64)]);
  const raw = [
    JSON.stringify({ type: "system", subtype: "init" }),
    JSON.stringify(good),
    JSON.stringify({ ...good, v: 2 }),
    '{"type":"frm.ctx", broken',
    "",
  ].join("\n");
  expect(framesOf(new TextEncoder().encode(raw))).toEqual([good]);
});

test("digests are stable when each call's start with the previous call's", () => {
  const a = "a".repeat(64);
  const b = "b".repeat(64);
  expect(stableDigests([frame([]), frame([a]), frame([]), frame([a, b])])).toBe(
    true,
  );
  expect(stableDigests([frame([a, b]), frame([a])])).toBe(false);
  expect(stableDigests([])).toBe(true);
});
