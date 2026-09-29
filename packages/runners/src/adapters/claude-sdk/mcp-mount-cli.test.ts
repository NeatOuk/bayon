// an earlier change on the real CLI: the session's MCP server, mounted after the handshake over the control
// channel, is connected before the first turn and again on adopt (a resumed process), and the bearer
// never shows in the records the adapter hands ingest (the raw log's bytes). The pinned bundled
// binary, a local Messages stand-in and a local /mcp stand-in that answers only the planted bearer.
// A dummy key, no model call, no Keychain, nothing past 127.0.0.1; skipped where this platform
// bundles no binary.
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { SessionHandle, SpawnSpec } from "../../adapter.js";
import { bundledBinary, createClaudeSdkAdapter } from "./adapter.js";
import { DEFAULTS, MODELS } from "./registration.js";
import { mcpStandIn, type McpStandIn } from "./testing/mcp-stand-in.js";
import {
  KEY,
  MODEL,
  QUIET,
  closeStandIn,
  mainLoop,
  standIn,
  toolsOf,
  within,
  type Hit,
  type StandIn,
} from "./testing/real-cli.js";

const BINARY = bundledBinary();
const PRESENT = BINARY !== undefined && existsSync(BINARY);
const BEARER = "frm-fake-mcp-bearer-for-the-mount-test";
const TOOL = "ticket_get";

describe.skipIf(!PRESENT)(
  "the pinned CLI connects the mounted MCP server, on spawn and on adopt",
  { timeout: 120_000 },
  () => {
    const hits: Hit[] = [];
    /** Every record's bytes the adapter handed over, both processes. */
    const recorded: Buffer[] = [];
    const adapter = createClaudeSdkAdapter();
    const local = new LocalExecutor({ id: "local", slots: new SlotCounter(2) });
    let api: StandIn | undefined;
    let mcp: McpStandIn | undefined;
    let root = "";
    let spec: SpawnSpec;

    beforeAll(async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "frm-claude-mount-")));
      api = await standIn(hits);
      mcp = await mcpStandIn(BEARER, [TOOL]);
      const cwd = join(root, "work");
      const homeDir = join(root, "home");
      for (const dir of [cwd, homeDir, join(root, "tmp")]) {
        mkdirSync(dir, { recursive: true });
      }
      spec = {
        sessionId: "01MOUNTCLI",
        cwd,
        homeDir,
        env: {
          ...QUIET,
          ANTHROPIC_BASE_URL: api.url,
          ANTHROPIC_API_KEY: KEY,
          HOME: homeDir,
          TMPDIR: join(root, "tmp"),
          PATH: process.env["PATH"] ?? "",
        },
        model: MODEL,
        flags: { ...DEFAULTS },
        mcp: { url: mcp.url, token: BEARER, tools: [TOOL] },
      };
      const home = await adapter.prepareHome(spec);
      if (!home.ok) throw new Error(home.error.message);
    });
    afterAll(async () => {
      await closeStandIn(api);
      await mcp?.close();
      rmSync(root, { recursive: true, force: true });
    });

    /** One run on `h` to its terminal event, then a graceful stop and the rest of its records. */
    async function turn(h: SessionHandle, n: number): Promise<unknown> {
      const records = adapter.records(h)[Symbol.asyncIterator]();
      const mapper = adapter.createMapper({ prices: MODELS });
      const sent = await adapter.send(h, {
        runId: `${spec.sessionId}-${n}`,
        text: "Reply with ok.",
        promptPath: `/${spec.sessionId}/run-${n}.md`,
      });
      if (!sent.ok) throw new Error(sent.error.message);
      let outcome: unknown;
      let offset = 0;
      try {
        while (outcome === undefined) {
          const next = await within(records.next(), "the next record");
          if (next.done === true) break;
          recorded.push(Buffer.from(next.value.bytes));
          outcome = mapper
            .map({
              offset,
              bytes: next.value.bytes,
              ts: Date.now(),
              partial: next.value.partial,
            })
            .find((e) => e.kind === "terminal")?.payload["outcome"];
          offset += next.value.bytes.length + 1;
        }
      } finally {
        await within(adapter.stop(h, "graceful"), "graceful stop");
      }
      for (;;) {
        const next = await within(records.next(), "the last records");
        if (next.done === true) break;
        recorded.push(Buffer.from(next.value.bytes));
      }
      return outcome;
    }

    const offered = (from: number): string[] =>
      mainLoop(hits.slice(from)).flatMap((hit) => [...toolsOf(hit).names]);

    test("the first turn offers the server's tool on spawn and on adopt; the bearer is in no record", async () => {
      const seen = (): readonly (string | undefined)[] =>
        mcp?.authorizations ?? [];
      const spawned = await within(adapter.spawn(spec, local), "spawn");
      if (!spawned.ok) throw new Error(spawned.error.message);
      expect(await turn(spawned.value, 1)).toBe("ok");
      expect(offered(0)).toContain(`mcp__foreman__${TOOL}`);
      expect(seen()).toContain(`Bearer ${BEARER}`);
      expect(seen().every((a) => a === `Bearer ${BEARER}`)).toBe(true);

      const before = hits.length;
      const seenBefore = seen().length;
      const adopted = await within(
        adapter.adopt(
          {
            ...spec,
            resumeRunnerSessionId: spawned.value.runnerSessionId ?? "",
          },
          local,
        ),
        "adopt",
      );
      if (!adopted.ok) throw new Error(adopted.error.message);
      expect(await turn(adopted.value, 2)).toBe("ok");
      // The resumed process connected again, with the same bearer, before its first turn.
      expect(seen().slice(seenBefore)).toContain(`Bearer ${BEARER}`);
      expect(offered(before)).toContain(`mcp__foreman__${TOOL}`);

      // What ingest writes to the raw log: never the bearer, over both processes.
      const all = Buffer.concat(recorded);
      expect(all.length).toBeGreaterThan(0);
      expect(all.includes(BEARER)).toBe(false);
    });
  },
);
