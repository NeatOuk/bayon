// The Messages API transform (spec M12) through the proxy's body rewriter, on a synthetic
// twelve-call series of one session whose history grows the way the CLI grows it: every earlier
// message serialises to the same bytes in every later call (the prompt-cache invariant), and only
// the allowlisted, non-error, non-store, non-diff results are compressed.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_STORE_DIR } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { createBodyRewriter } from "../../context-rewrite.js";
import { CLAUDE_CONTEXT, PRECONNECT_PATH } from "./context.js";

const root = realpathSync(mkdtempSync(join(tmpdir(), "frm-claude-ctx-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const lines = (tag: string, n = 400): string =>
  Array.from({ length: n }, (_, i) =>
    i === n / 2
      ? `ERROR ${tag}: E-${1000 + i} broke`
      : `INFO ${tag} step ${i} ok`,
  ).join("\n");
const diff = (): string =>
  [
    "diff --git a/x.ts b/x.ts",
    "--- a/x.ts",
    "+++ b/x.ts",
    "@@ -1,300 +1,300 @@",
    ...Array.from({ length: 300 }, (_, i) => `-old ${i}\n+new ${i}`),
  ].join("\n");

type Msg = { role: string; content: unknown };

/** One tool round: the assistant's call and the user's result, as the CLI appends them. */
function round(
  i: number,
  name: string,
  input: unknown,
  content: unknown,
  extra: Record<string, unknown> = {},
): Msg[] {
  const id = `toolu_${String(i).padStart(2, "0")}`;
  return [
    {
      role: "assistant",
      content: [
        { type: "text", text: `step ${i}` },
        { type: "tool_use", id, name, input },
      ],
    },
    {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: id, content, ...extra }],
    },
  ];
}

const IMAGE = {
  type: "image",
  source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" },
};

/** The session's rounds, in order; call k sends the prompt and the first k rounds. */
const ROUNDS: Msg[][] = [
  round(1, "Bash", { command: "npm test" }, lines("test")),
  round(2, "Read", { file_path: "/w/big.log" }, lines("read")),
  round(3, "Grep", { pattern: "x" }, lines("grep")),
  round(4, "Bash", { command: "make" }, lines("make"), { is_error: true }),
  round(5, "Bash", { command: "cat .foreman/ctx/abc.txt" }, lines("store")),
  round(6, "Bash", { command: "git diff" }, diff()),
  round(7, "Glob", { pattern: "**/*" }, lines("glob")),
  round(8, "TaskOutput", { task_id: "b1" }, lines("bg")),
  round(9, "Bash", { command: "screenshot" }, [
    { type: "text", text: lines("shot") },
    IMAGE,
  ]),
  round(10, "Bash", { command: "ls" }, "a\nb\n"),
  round(11, "Bash", { command: "cat log" }, lines("cached"), {
    cache_control: { type: "ephemeral" },
  }),
  round(12, "mcp__foreman__ticket_read", { id: "T" }, lines("mcp")),
];

const bodyAt = (k: number): string =>
  JSON.stringify({
    model: "claude-sonnet-4-5",
    max_tokens: 1024,
    stream: true,
    system: [{ type: "text", text: "system" }],
    messages: [
      { role: "user", content: "fix the tests" },
      ...ROUNDS.slice(0, k).flat(),
    ],
  });

test("a growing history: earlier messages serialise the same in every later call", async () => {
  const cwd = join(root, "series");
  mkdirSync(cwd, { recursive: true });
  const rewriter = createBodyRewriter({
    transform: CLAUDE_CONTEXT,
    storeDir: join(cwd, CONTEXT_STORE_DIR),
  });
  const sent: Msg[][] = [];
  const digests: (readonly string[])[] = [];
  for (let k = 1; k <= ROUNDS.length; k += 1) {
    const raw = Buffer.from(bodyAt(k));
    const out = await rewriter.rewrite(raw, undefined);
    expect(out.untouched).toBeUndefined();
    const body = JSON.parse((out.body ?? raw).toString()) as {
      messages: Msg[];
    };
    sent.push(body.messages);
    digests.push(out.counts.digests);
  }
  for (let k = 1; k < sent.length; k += 1) {
    const before = sent[k - 1] ?? [];
    const now = sent[k] ?? [];
    before.forEach((m, i) =>
      expect(JSON.stringify(now[i]), `call ${k + 1}, message ${i}`).toBe(
        JSON.stringify(m),
      ),
    );
    expect(now.length).toBeGreaterThan(before.length);
    // Each call's compressed blocks start with the previous call's.
    expect(digests[k]?.slice(0, digests[k - 1]?.length)).toEqual(
      digests[k - 1],
    );
  }

  const last = sent.at(-1) ?? [];
  const resultOf = (i: number): Record<string, unknown> =>
    ((last[2 * i] as Msg).content as Record<string, unknown>[])[0] ?? {};
  const text = (i: number): string => {
    const c = resultOf(i)["content"];
    return typeof c === "string" ? c : JSON.stringify(c);
  };
  const marked = (i: number) => text(i).includes("[frm-ctx ctx1]");
  // Allowlisted and eligible: compressed, the error line kept.
  expect([1, 3, 7, 8, 9, 11].map(marked)).toEqual([
    true,
    true,
    true,
    true,
    true,
    true,
  ]);
  expect(text(1)).toContain("ERROR test: E-1200 broke");
  // Read, an error result, a read of the store, a diff, a small result and an MCP tool: whole.
  expect([2, 4, 5, 6, 10, 12].map(marked)).toEqual([
    false,
    false,
    false,
    false,
    false,
    false,
  ]);
  expect(text(2)).toBe(lines("read"));
  expect(text(6)).toBe(diff());
  // The image beside a compressed text, and cache_control, exactly as they were.
  const shot = resultOf(9)["content"] as Record<string, unknown>[];
  expect(shot[1]).toEqual(IMAGE);
  expect(resultOf(11)["cache_control"]).toEqual({ type: "ephemeral" });
  expect(Object.keys(resultOf(11))).toEqual([
    "type",
    "tool_use_id",
    "content",
    "cache_control",
  ]);
  expect(digests.at(-1)).toHaveLength(6);
});

test("routes: messages with a frame, token counting without, other API paths pass, the rest refused", () => {
  expect(CLAUDE_CONTEXT.route("POST", "/v1/messages")).toBe("compress");
  expect(CLAUDE_CONTEXT.route("POST", "/v1/messages/count_tokens")).toBe(
    "quiet",
  );
  expect(CLAUDE_CONTEXT.route("GET", "/v1/models")).toBe("pass");
  expect(CLAUDE_CONTEXT.route("POST", "/api/event_logging/batch")).toBe("pass");
  expect(CLAUDE_CONTEXT.route("GET", "/")).toBeUndefined();
  expect(CLAUDE_CONTEXT.route("GET", "/etc/passwd")).toBeUndefined();
});

test("the one probe is the CLI's preconnect, HEAD /api/hello; any other call there needs the bearer", () => {
  // The proxy answers only a HEAD to a probe path without the bearer (model-proxy-probe.test.ts);
  // on the real CLI, tool-search-cli.test.ts.
  expect(CLAUDE_CONTEXT.probes).toEqual([PRECONNECT_PATH]);
  expect(PRECONNECT_PATH).toBe("/api/hello");
  expect(CLAUDE_CONTEXT.route("GET", PRECONNECT_PATH)).toBe("pass");
});

test("a body that is not a Messages request comes back as it was", () => {
  const odd = { model: "m", messages: "nope" };
  expect(CLAUDE_CONTEXT.rewrite(odd, () => "x")).toBe(odd);
  const orphan = {
    messages: [
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "none", content: "a" }],
      },
      { role: "user", content: "plain" },
    ],
  };
  expect(CLAUDE_CONTEXT.rewrite(orphan, () => "x")).toEqual(orphan);
  expect(CLAUDE_CONTEXT.mayHold('{"messages":[]}')).toBe(false);
});
