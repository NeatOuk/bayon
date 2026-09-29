// Live evidence for the context proxy (spec M12): the real, pinned opencode behind a
// real proxy, inside its real Seatbelt profile, against a local stand-in provider (no model, no
// network). It answers the review's question: does opencode persist a resolved copy of its config,
// with the `{env:FRM_CTX_TOKEN}` header substituted, anywhere on disk? Skipped unless FRM_REAL_RUNNER=1
// and an `opencode` on PATH:
//   FRM_REAL_RUNNER=1 pnpm exec vitest run packages/runners/src/adapters/opencode/context-live.test.ts
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CONTEXT_RULESET, CONTEXT_STORE_DIR } from "@bayon/core";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { MappedEvent, SpawnSpec } from "../../adapter.js";
import { createOpencodeAdapter } from "./adapter.js";
import { DEFAULTS, MODELS, OLLAMA_BASE_URL_ENV } from "./registration.js";

const LIVE = process.env["FRM_REAL_RUNNER"] === "1";

/** An OpenAI-compatible chat endpoint that streams "OK" to anything, and records each call. */
function standIn(): Promise<{
  readonly server: Server;
  readonly url: string;
  readonly calls: { readonly url: string; readonly headers: string }[];
}> {
  const calls: { url: string; headers: string }[] = [];
  const chunk = (delta: object, finish: string | null, usage?: object) =>
    `data: ${JSON.stringify({
      id: "chatcmpl-standin",
      object: "chat.completion.chunk",
      created: 1,
      model: "standin",
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage === undefined ? {} : { usage }),
    })}\n\n`;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      calls.push({ url: req.url ?? "", headers: JSON.stringify(req.headers) });
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chunk({ role: "assistant", content: "OK" }, null));
      res.write(
        chunk({}, "stop", {
          prompt_tokens: 10,
          completion_tokens: 1,
          total_tokens: 11,
        }),
      );
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        calls,
      }),
    ),
  );
}

/** Every file under `dir` (none when it is missing), symlinks not followed. */
function filesUnder(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true, recursive: true })
      .filter((e) => e.isFile())
      .map((e) => join(e.parentPath, e.name));
  } catch {
    return [];
  }
}

describe.skipIf(!LIVE)(
  "the real opencode behind the context proxy",
  { timeout: 300_000 },
  () => {
    let root = "";
    let provider: Awaited<ReturnType<typeof standIn>> | undefined;
    beforeAll(async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "frm-oc-ctx-live-")));
      provider = await standIn();
    });
    afterAll(() => {
      provider?.server.close();
      if (root !== "") rmSync(root, { recursive: true, force: true });
    });

    test("one turn through the proxy; the bearer is nowhere on disk afterwards", async () => {
      const cwd = join(root, "work");
      mkdirSync(cwd, { recursive: true });
      writeFileSync(join(cwd, "README.md"), "# fixture\n");
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          ["-c", "user.name=frm", "-c", "user.email=frm@localhost", ...args],
          { cwd, stdio: "ignore" },
        );
      git("init", "-q");
      git("add", ".");
      git("commit", "-qm", "init");
      const token = randomBytes(32).toString("hex");
      const spec: SpawnSpec = {
        sessionId: "01JLIVECTX",
        cwd,
        homeDir: join(root, "home"),
        env: {
          PATH: process.env["PATH"] ?? "",
          [OLLAMA_BASE_URL_ENV]: `${provider?.url ?? ""}/v1`,
        },
        model:
          MODELS.find((m) => m.tier === "cheap")?.model ?? "ollama/unknown",
        flags: { ...DEFAULTS },
        contextCompression: {
          ruleset: CONTEXT_RULESET,
          storeDir: join(root, CONTEXT_STORE_DIR),
          token,
        },
      };
      const local = new LocalExecutor({
        id: "local",
        slots: new SlotCounter(2),
      });
      const adapter = createOpencodeAdapter({
        graceMs: 5_000,
        contextLog: () => undefined,
      });
      expect((await adapter.prepareHome(spec, local)).ok).toBe(true);
      const h = await adapter.spawn(spec, local);
      if (!h.ok) throw new Error(h.error.message);
      const records = adapter.records(h.value)[Symbol.asyncIterator]();
      const mapper = adapter.createMapper({ prices: MODELS });
      expect(
        (
          await adapter.send(h.value, {
            runId: "live-ctx",
            text: "Reply with the single word OK.",
            promptPath: "/dev/null",
          })
        ).ok,
      ).toBe(true);
      const events: MappedEvent[] = [];
      for (let offset = 0; ;) {
        const next = await records.next();
        if (next.done === true) break;
        events.push(...mapper.map({ offset, bytes: next.value.bytes, ts: 1 }));
        offset += next.value.bytes.length + 1;
        if (events.some((e) => e.kind === "terminal")) break;
      }
      await adapter.stop(h.value, "graceful");

      const terminal = events.find((e) => e.kind === "terminal");
      expect(terminal?.payload["outcome"]).toBe("ok");
      // The call went through the proxy: it reached the stand-in, the bearer stripped on the way.
      expect(terminal?.payload["context"]).toMatchObject({ calls: 1 });
      const calls = provider?.calls ?? [];
      expect(calls.some((c) => c.url === "/v1/chat/completions")).toBe(true);
      expect(calls.every((c) => !c.headers.includes(token))).toBe(true);
      // Every file the session could have left: its home (XDG config, data, cache, state, tmp and
      // opencode's logs and database), the turn host's own dir, the worktree, and the store.
      const scanned = [
        spec.homeDir,
        `${spec.homeDir}.frm-host`,
        cwd,
        join(root, CONTEXT_STORE_DIR),
      ].flatMap(filesUnder);
      const holding = scanned.filter((f) => readFileSync(f).includes(token));
      process.stdout.write(
        `context-live: scanned ${scanned.length} files; holding the bearer: ${holding.length}\n${scanned
          .map((f) => `  ${f.slice(root.length)}`)
          .join("\n")}\n`,
      );
      // The scan does see what opencode keeps: the prompt is in its own store.
      expect(
        scanned.some((f) =>
          readFileSync(f).includes("Reply with the single word OK."),
        ),
      ).toBe(true);
      expect(holding).toEqual([]);
    });
  },
);
