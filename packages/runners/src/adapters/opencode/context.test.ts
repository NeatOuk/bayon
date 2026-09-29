// The chat-completions transform (spec M12) through the proxy's body rewriter, on a
// synthetic eleven-call series of one opencode session whose history grows: every earlier message
// serialises to the same bytes in every later call, and only bash, grep and glob results that do not
// read the store are compressed.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_STORE_DIR } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { createBodyRewriter } from "../../context-rewrite.js";
import { OPENCODE_CONTEXT } from "./context.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-oc-ctx-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const lines = (tag: string, n = 400): string =>
  Array.from({ length: n }, (_, i) =>
    i === n / 2 ? `error: ${tag} E-${2000 + i}` : `${tag} line ${i} fine`,
  ).join("\n");
const items = (): string =>
  JSON.stringify(
    Array.from({ length: 300 }, (_, i) => ({
      id: i,
      name: `item-${i}`,
      ok: true,
    })),
    null,
    2,
  );

type Msg = Record<string, unknown>;

function round(
  i: number,
  name: string,
  args: unknown,
  content: unknown,
): Msg[] {
  const id = `call_${String(i).padStart(2, "0")}`;
  return [
    {
      role: "assistant",
      content: "",
      tool_calls: [
        {
          id,
          type: "function",
          function: { name, arguments: JSON.stringify(args) },
        },
      ],
    },
    { role: "tool", tool_call_id: id, content },
  ];
}

const ROUNDS: Msg[][] = [
  round(1, "bash", { command: "npm test" }, lines("test")),
  round(2, "read", { filePath: "big.log" }, lines("read")),
  round(3, "grep", { pattern: "x" }, lines("grep")),
  round(4, "bash", { command: "cat items.json" }, items()),
  round(
    5,
    "bash",
    { command: "grep TAG .foreman/ctx/abc.txt" },
    lines("store"),
  ),
  round(6, "glob", { pattern: "**/*" }, lines("glob")),
  round(7, "bash", { command: "ls" }, "a\nb\n"),
  round(8, "bash", { command: "parts" }, [
    { type: "text", text: lines("parts") },
    { type: "other", data: 1 },
  ]),
  round(9, "webfetch", { url: "http://x" }, lines("web")),
  round(10, "foreman_ticket_read", { id: "T" }, lines("mcp")),
];

const bodyAt = (k: number): string =>
  JSON.stringify({
    model: "qwen",
    messages: [
      { role: "system", content: "sys" },
      { role: "user", content: "fix it" },
      ...ROUNDS.slice(0, k).flat(),
    ],
    stream: true,
  });

test("a growing history: earlier messages serialise the same in every later call", async () => {
  const cwd = join(root, "series");
  mkdirSync(cwd, { recursive: true });
  const rewriter = createBodyRewriter({
    transform: OPENCODE_CONTEXT,
    storeDir: join(cwd, CONTEXT_STORE_DIR),
  });
  const sent: Msg[][] = [];
  // The first call has no tool message at all: the cheap look says so, and nothing is parsed.
  const first = await rewriter.rewrite(Buffer.from(bodyAt(0)), undefined);
  expect(first).toEqual({ counts: expect.objectContaining({ blocks: 0 }) });
  for (let k = 1; k <= ROUNDS.length; k += 1) {
    const raw = Buffer.from(bodyAt(k));
    const out = await rewriter.rewrite(raw, undefined);
    expect(out.untouched).toBeUndefined();
    sent.push(
      (JSON.parse((out.body ?? raw).toString()) as { messages: Msg[] })
        .messages,
    );
  }
  for (let k = 1; k < sent.length; k += 1) {
    (sent[k - 1] ?? []).forEach((m, i) =>
      expect(JSON.stringify(sent[k]?.[i]), `call ${k + 1}, message ${i}`).toBe(
        JSON.stringify(m),
      ),
    );
  }
  const last = sent.at(-1) ?? [];
  const content = (i: number): unknown => last[1 + 2 * i]?.["content"];
  const marked = (i: number) =>
    JSON.stringify(content(i)).includes("[frm-ctx ctx1]");
  expect([1, 3, 4, 6, 8].map(marked)).toEqual([true, true, true, true, true]);
  expect([2, 5, 7, 9, 10].map(marked)).toEqual([
    false,
    false,
    false,
    false,
    false,
  ]);
  expect(content(1)).toContain("error: test E-2200");
  expect((content(8) as unknown[])[1]).toEqual({ type: "other", data: 1 });
});

test("routes: completions with a frame, the model list passes, the rest refused", () => {
  expect(OPENCODE_CONTEXT.route("POST", "/chat/completions")).toBe("compress");
  expect(OPENCODE_CONTEXT.route("GET", "/models")).toBe("pass");
  expect(OPENCODE_CONTEXT.route("POST", "/models")).toBeUndefined();
  expect(OPENCODE_CONTEXT.route("POST", "/api/pull")).toBeUndefined();
});

test("a body that is not a chat request comes back as it was", () => {
  const odd = { messages: {} };
  expect(OPENCODE_CONTEXT.rewrite(odd, () => "x")).toBe(odd);
  const orphan = {
    messages: [{ role: "tool", tool_call_id: "none", content: "a" }],
  };
  expect(OPENCODE_CONTEXT.rewrite(orphan, () => "x")).toEqual(orphan);
});
