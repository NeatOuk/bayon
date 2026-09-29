// Live evidence: the real Codex CLI 0.154.0 against the real API, through the
// real turn host and local executor. CI never sets FRM_REAL_RUNNER, so this is skipped there; until a
// credential is in the host store, the stub tests (adapter.test.ts, conformance-stub.test.ts) are
// the evidence. Codex must be on PATH at the pinned version (`npm i -g @openai/codex@0.154.0`):
//   FRM_REAL_RUNNER=1 CODEX_API_KEY="$(security find-generic-password -s foreman -a CODEX_API_KEY -w)" \
//     pnpm vitest run packages/runners/src/adapters/codex-exec/live.test.ts
//   FRM_RECORD=1 also writes the host's raw stdout to fixtures/codex-exec/recorded/ (gitignored).
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { REVIEW_OUTPUT_JSON_SCHEMA, parseReviewOutput } from "@bayon/core";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type {
  MappedEvent,
  RawRecord,
  SessionHandle,
  SpawnSpec,
} from "../../adapter.js";
import { createCodexExecAdapter } from "./adapter.js";
import { DEFAULTS, MODELS } from "./registration.js";

const LIVE = process.env["FRM_REAL_RUNNER"] === "1";
const RECORD = process.env["FRM_RECORD"] === "1";
const RECORDED = fileURLToPath(
  new URL("../../../fixtures/codex-exec/recorded/", import.meta.url),
);

describe.skipIf(!LIVE)("the live Codex runner", { timeout: 900_000 }, () => {
  // Whichever credential the operator has, first in the registration's one-of order.
  const auth = DEFAULTS.secretEnvAnyOf.flat().find((name) => process.env[name]);
  const key = auth === undefined ? "" : (process.env[auth] ?? "");
  // Made in beforeAll, not here: this body runs at collection even when the suite is skipped, and a
  // skipped suite's afterAll never runs, so every plain run leaked an empty directory.
  let root = "";
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "frm-codex-live-")));
  });
  afterAll(() => {
    if (root !== "") rmSync(root, { recursive: true, force: true });
  });
  const local = new LocalExecutor({ id: "local", slots: new SlotCounter(2) });
  const adapter = createCodexExecAdapter();
  const raw: string[] = [];

  function repo(): string {
    const dir = join(root, "repo");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "README.md"), "# live\n");
    writeFileSync(
      join(dir, "add.js"),
      "export function add(a, b) {\n  return a - b;\n}\n",
    );
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
    const who = ["-c", "user.name=frm", "-c", "user.email=frm@localhost"];
    git("init", "-q");
    git(...who, "add", ".");
    git(...who, "commit", "-qm", "init");
    return dir;
  }

  function reader(records: AsyncIterable<RawRecord>) {
    const iterator = records[Symbol.asyncIterator]();
    const mapper = adapter.createMapper({ prices: MODELS });
    let offset = 0;
    return async (): Promise<MappedEvent[]> => {
      const out: MappedEvent[] = [];
      for (;;) {
        const next = await iterator.next();
        if (next.done === true) return out;
        raw.push(new TextDecoder().decode(next.value.bytes));
        const events = mapper.map({
          offset,
          bytes: next.value.bytes,
          ts: Date.now(),
          partial: next.value.partial,
        });
        offset += next.value.bytes.length + 1;
        out.push(...events);
        if (events.some((e) => e.kind === "terminal")) return out;
      }
    };
  }

  const usageOf = (events: readonly MappedEvent[]) =>
    events.find((e) => e.kind === "usage")?.payload["usage"] as
      { tokens_out: number } | undefined;

  test("a real thread: a turn, a resume, usage semantics, an interrupt, a structured review, no leaked key", async () => {
    expect(key).not.toBe("");
    expect(await adapter.health(local)).toMatchObject({ ok: true });

    const cwd = repo();
    const cheap = MODELS.find((m) => m.tier === "cheap");
    const spec: SpawnSpec = {
      sessionId: "01LIVECODEX",
      cwd,
      homeDir: join(root, "home"),
      env: {
        PATH: process.env["PATH"] ?? "",
        HOME: join(root, "home"),
        ...(auth === undefined ? {} : { [auth]: key }),
      },
      model: cheap?.model ?? "",
      effort: "low",
      flags: { ...DEFAULTS },
    };
    expect((await adapter.prepareHome(spec)).ok).toBe(true);
    const spawned = await adapter.spawn(spec, local);
    if (!spawned.ok) throw new Error(spawned.error.message);
    const h: SessionHandle = spawned.value;
    const run = reader(adapter.records(h));
    const send = (runId: string, text: string) =>
      adapter.send(h, { runId, text, promptPath: `/live/${runId}.md` });

    // Turn 1: a long answer. Turn 2, resumed: one word. Thread totals ⇔ out2 ≥ out1 (fact 3).
    await send(
      "live-1",
      "Write about 150 words on why tests matter. Plain text.",
    );
    const run1 = await run();
    expect(run1.at(-1)?.payload).toMatchObject({ outcome: "ok" });
    await send("live-2", "Reply with the single word done.");
    const run2 = await run();
    expect(run2.at(-1)?.payload).toMatchObject({ outcome: "ok" });
    const [out1, out2] = [usageOf(run1)?.tokens_out, usageOf(run2)?.tokens_out];
    expect(out1).toBeGreaterThan(0);
    // USAGE_SCOPE = "thread" holds only if this does; otherwise flip it to "process".
    expect(out2).toBeGreaterThanOrEqual(out1 ?? Number.POSITIVE_INFINITY);

    // SIGINT mid-tool (fact 2): no Codex terminal, the host's interrupt + exit give interrupted.
    await send("live-3", "Run the shell command `sleep 30`, then reply DONE.");
    const asked = Date.now();
    expect((await adapter.interrupt(h)).ok).toBe(true);
    expect((await run()).at(-1)?.payload).toMatchObject({
      outcome: "interrupted",
      basis: "interrupt+exit",
    });
    expect(Date.now() - asked).toBeLessThan(5_000);

    // The model's shell sees core variables only: the key never reaches it (HIGH 5).
    await send("live-4", "Run the shell command `env` and reply DONE.");
    expect((await run()).at(-1)?.payload).toMatchObject({ outcome: "ok" });

    // A structured review through --output-schema and -o, read only from the output file.
    const output = join(root, "review.json");
    await adapter.send(h, {
      runId: "live-5",
      text: "Review the file add.js for bugs, and report each one as a finding.",
      promptPath: "/live/live-5.md",
      output: { schema: REVIEW_OUTPUT_JSON_SCHEMA, path: output },
    });
    expect((await run()).at(-1)?.payload).toMatchObject({ outcome: "ok" });
    const review = parseReviewOutput(readFileSync(output, "utf8"), true);
    expect(review).toMatchObject({ ok: true, value: { parse: "schema" } });

    await adapter.stop(h, "graceful");
    const text = `${raw.join("\n")}\n`;
    expect(text.includes(key)).toBe(false); // compared here, never printed
    if (RECORD) {
      mkdirSync(RECORDED, { recursive: true });
      writeFileSync(join(RECORDED, `live-${Date.now()}.jsonl`), text);
    }
  });
});
