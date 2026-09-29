// Design an earlier change tests 11 and 15, end to end with no key and no spend. The supervisor's spawn
// pipeline mints the token and mounts /mcp; the real SDK runs its stand-in CLI through the local
// executor; the stand-in expands the header reference from its own env (F2) and calls the real API,
// built and run as a child on the same FRM_HOME and database. Ingest records the calls, redacts
// the echoed secrets, and vouches for the API's truncation marker but not for a fake one.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import {
  getEventsSince,
  getSession,
  listRuns,
  type Db,
  type EventRow,
} from "@bayon/db";
import { listAudit, seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import type { RunnerAdapter, SpawnSpec } from "@bayon/runners";
import { STUB_RUNNER_IDS, loadStubAdapter } from "@bayon/runners/testing";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { LOCAL_EXECUTOR_ID, upsertBootRows } from "../boot.js";
import { buildApi, startApiChild } from "./testing/api-child.js";
import {
  CMD,
  spawnPayload,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";

const OPERATOR = "rt-operator-token-0123456789abcdef";
/** A stand-in credential: the stand-in CLI calls no model. */
const CREDENTIAL = "stand-in-credential-0123456789abcdef";
const SESSION = "RT";
const WAIT = { timeout: 30_000, interval: 50 };
const CALLS = [
  { tool: "mission_read", args: {} },
  {
    tool: "human_ask",
    args: { questions: [{ question: "Ship it?", options: ["yes", "no"] }] },
  },
];
const HASH = "0".repeat(64);

const Defaults = z.looseObject({
  secretEnvAnyOf: z.array(z.array(z.string()).min(1)).min(1),
});

const cleanups: (() => Promise<void> | void)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.toReversed()) await cleanup();
});

beforeAll(buildApi, 180_000);

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

async function eventsOf(db: Db, sessionId: string): Promise<EventRow[]> {
  return unwrap(await getEventsSince(db, { sessionId, since: 0, limit: 1000 }))
    .rows;
}

describe("the stub-CLI MCP round trip", { timeout: 90_000 }, () => {
  test("the token reaches /mcp only through env; calls are recorded, capped, redacted and audited", async () => {
    const [runnerId] = STUB_RUNNER_IDS;
    if (runnerId === undefined) throw new Error("no stand-in runner");
    const adapter = unwrap(loadStubAdapter(runnerId));
    const specs: SpawnSpec[] = [];
    const recorded: RunnerAdapter = {
      ...adapter,
      spawn: (spec, ex) => {
        specs.push(spec);
        return adapter.spawn(spec, ex);
      },
    };
    const registration = adapter.registration();
    const credentialName = Defaults.parse(registration.runner.defaults)
      .secretEnvAnyOf[0]?.[0];
    if (credentialName === undefined) throw new Error("no credential name");

    const clock = new FakeClock(1_700_000_000_000);
    const home = tempHome("frm-rt-");
    const t = unwrap(await tempDb(clock));
    cleanups.push(() => {
      t.cleanup();
      home.cleanup();
    });
    unwrap(await upsertBootRows(t.db, { registrations: [registration] }));
    unwrap(
      await seedRows(t.db, {
        missions: [
          {
            id: "RT-M",
            agent_name: "rt-builder",
            version: 1,
            who_md: "who",
            what_md: "what",
            how_md: "how",
            laws_md: "laws",
            rendered_md: "r".repeat(20_000),
            hash: HASH,
            note: "v1",
            created_at: 0,
            created_by: "operator",
          },
        ],
        profiles: [
          {
            id: "RT-P",
            name: "RT-P",
            runner_id: adapter.id,
            model_tier: "cheap",
            env_json: JSON.stringify({
              FRM_STUB_MCP: JSON.stringify(CALLS),
              FRM_STUB_ECHO: `FRM_MCP_TOKEN,${credentialName}`,
            }),
            tool_allowlist_json: JSON.stringify(["mission_read", "human_ask"]),
            version: 1,
            hash: HASH,
            created_at: 0,
          },
        ],
        agents: [
          {
            id: "RT-A",
            name: "rt-builder",
            kind: "builder",
            runner_id: adapter.id,
            executor_id: LOCAL_EXECUTOR_ID,
            profile_id: "RT-P",
            mission_id: "RT-M",
            created_at: 0,
          },
        ],
        // Low enough that mission_read trips the API's backstop and writes its marker.
        settings: [{ key: "mcp.cap_bytes", value_json: "1024", updated_at: 0 }],
      }),
    );

    const api = await startApiChild({
      home: home.path,
      dbPath: t.path,
      token: OPERATOR,
    });
    cleanups.push(api.stop);

    const slots = new SlotCounter(2);
    const started = await startLifecycle({
      db: t.db,
      clock,
      frmHome: home.path,
      executor: new LocalExecutor({ id: LOCAL_EXECUTOR_ID, slots }),
      slots,
      adapter: recorded,
      secrets: { [`FRM_SECRET_${credentialName}`]: CREDENTIAL },
      mcpUrl: api.mcpUrl,
    });
    cleanups.push(async () => {
      await started.lifecycle.handlers.stop.handle(
        { session_id: SESSION, mode: "kill" },
        CMD,
      );
      await started.lifecycle.settled();
      await started.lifecycle.shutdown();
    });

    unwrap(
      await started.lifecycle.handlers.spawn.handle(
        spawnPayload(SESSION, { agent_id: "RT-A", prompt: "go" }),
        CMD,
      ),
    );
    await vi.waitFor(async () => {
      await started.lifecycle.settled();
      expect(unwrap(await listRuns(t.db, SESSION))[0]?.state).toBe("ok");
    }, WAIT);

    // Test 11: the token went to the runner over its stdin: neither argv nor its env.
    const [spec] = specs;
    const token = spec?.mcp?.token ?? "";
    expect(token).not.toBe("");
    const argv = readFileSync(join(spec?.homeDir ?? "", "argv.json"), "utf8");
    expect(argv.includes(token)).toBe(false);
    expect(
      JSON.parse(readFileSync(join(spec?.homeDir ?? "", "auth.json"), "utf8")),
    ).not.toHaveProperty("FRM_MCP_TOKEN");
    expect(
      JSON.parse(
        readFileSync(join(spec?.homeDir ?? "", "mcp-tools.json"), "utf8"),
      ),
    ).toEqual(spec?.mcp?.tools);

    const rows = await eventsOf(t.db, SESSION);
    expect(
      rows.filter((r) => r.kind === "mcp_call").map((r) => r.tool_name),
    ).toEqual(["mission_read", "human_ask"]);
    const results = rows.filter((r) => r.kind === "tool_result");
    const toolDir = join(
      home.path,
      "runtime",
      "sessions",
      SESSION,
      "logs",
      "tool",
    );
    const capped = results.find(
      (r) =>
        r.truncated === 1 && r.payload_path?.startsWith(join(toolDir, "mcp-")),
    );
    expect(capped).toBeDefined();
    expect(statSync(capped?.payload_path ?? "").size).toBe(
      capped?.bytes_original,
    );
    const fake = results.find((r) => r.text?.includes("/etc/passwd"));
    expect(fake?.truncated).toBe(0);
    expect(unwrap(await listAudit(t.db))).toContainEqual(
      expect.objectContaining({
        actor: `session:${SESSION}`,
        action: "mcp.human_ask",
      }),
    );

    // Test 15: the echoed token and credential are nowhere ingest writes (Invariant 11).
    const logs = join(home.path, "runtime", "sessions", SESSION, "logs");
    const files = filesUnder(logs).map((file) => readFileSync(file, "utf8"));
    expect(files.join("\n")).toContain("[redacted]");
    const everywhere = [
      ...files,
      ...rows.flatMap((r) => [r.text ?? "", r.payload_json ?? ""]),
      JSON.stringify(unwrap(await getSession(t.db, SESSION))),
    ];
    expect(everywhere.some((text) => text.includes(token))).toBe(false);
    expect(everywhere.some((text) => text.includes(CREDENTIAL))).toBe(false);
  });
});
