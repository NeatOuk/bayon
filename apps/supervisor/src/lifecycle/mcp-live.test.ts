// Design an earlier change test 16: one gated real run. The real SDK and CLI, the real API as a child and a
// real model call, over the operator's credential. CI never sets FRM_REAL_RUNNER, so it is skipped
// there:
//   FRM_REAL_RUNNER=1 FRM_SECRET_<CREDENTIAL>=… pnpm vitest run apps/supervisor/src/lifecycle/mcp-live.test.ts
// It shows what only a real runner can: the CLI's init lists the MCP server connected, the model's
// ticket_get arrives as an mcp_call, its ticket_comment lands attributed to the session, and neither
// `ps` nor anything under logs/ holds the token. Every token check is a boolean, so a failure can
// never print one.
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import {
  getEventsSince,
  getSession,
  listRuns,
  listTicketEvents,
} from "@bayon/db";
import {
  listAudit,
  seedRows,
  tempDb,
  ticketRow,
  unwrap,
} from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import {
  loadAdapter,
  type RunnerAdapter,
  type SpawnSpec,
} from "@bayon/runners";
import { STUB_RUNNER_IDS } from "@bayon/runners/testing";
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

const LIVE = process.env["FRM_REAL_RUNNER"] === "1";
const OPERATOR = "live-operator-token-0123456789abcdef";
const SESSION = "LIVE";
const TICKET = "ticket-1";
const HASH = "0".repeat(64);
const WAIT = { timeout: 240_000, interval: 250 };
const PROMPT = [
  "You have MCP tools from the server named foreman.",
  'Call ticket_get with {"ticket": "1"}.',
  'Then call ticket_comment with {"ticket": "1", "body_md": "live MCP run ok"}.',
  "Then reply with the ticket's title and nothing else.",
].join("\n");

const Defaults = z.looseObject({
  secretEnvAnyOf: z.array(z.array(z.string()).min(1)).min(1),
});
const Init = z.looseObject({
  mcp_servers: z.array(z.looseObject({ name: z.string(), status: z.string() })),
});

const filesUnder = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));

describe.skipIf(!LIVE)(
  "the gated real MCP run (design test 16)",
  { timeout: 360_000 },
  () => {
    const cleanups: (() => Promise<void> | void)[] = [];
    beforeAll(buildApi, 180_000);
    afterAll(async () => {
      for (const cleanup of cleanups.toReversed()) await cleanup();
    });

    test("init shows foreman connected; ticket_get is an mcp_call; the comment is the session's; no token in ps or logs", async () => {
      // The runner that has a stand-in also has the real CLI: here, the real one.
      const [runnerId] = STUB_RUNNER_IDS;
      if (runnerId === undefined) throw new Error("no runner with a CLI");
      const adapter = unwrap(loadAdapter(runnerId));
      const specs: SpawnSpec[] = [];
      const recorded: RunnerAdapter = {
        ...adapter,
        spawn: (spec, ex) => {
          specs.push(spec);
          return adapter.spawn(spec, ex);
        },
      };
      const registration = adapter.registration();
      const chosen = Defaults.parse(
        registration.runner.defaults,
      ).secretEnvAnyOf.find((names) =>
        names.every((name) => Boolean(process.env[`FRM_SECRET_${name}`])),
      );
      if (chosen === undefined) {
        throw new Error(
          "set FRM_SECRET_<name> for one of the runner's credentials",
        );
      }
      const secrets = Object.fromEntries(
        chosen.map((name) => [
          `FRM_SECRET_${name}`,
          process.env[`FRM_SECRET_${name}`] ?? "",
        ]),
      );

      const clock = new FakeClock(Date.now());
      const home = tempHome("frm-live-");
      const t = unwrap(await tempDb(clock));
      cleanups.push(() => {
        t.cleanup();
        home.cleanup();
      });
      unwrap(await upsertBootRows(t.db, { registrations: [registration] }));
      unwrap(
        await seedRows(t.db, {
          tickets: [
            ticketRow(1, { status: "building", title: "live MCP ticket" }),
          ],
          profiles: [
            {
              id: "LIVE-P",
              name: "LIVE-P",
              runner_id: adapter.id,
              model_tier: "cheap",
              tool_allowlist_json: JSON.stringify([
                "ticket_get",
                "ticket_comment",
              ]),
              version: 1,
              hash: HASH,
              created_at: 0,
            },
          ],
          agents: [
            {
              id: "LIVE-A",
              name: "live-builder",
              kind: "builder",
              runner_id: adapter.id,
              executor_id: LOCAL_EXECUTOR_ID,
              profile_id: "LIVE-P",
              created_at: 0,
            },
          ],
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
        secrets,
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
          spawnPayload(SESSION, {
            agent_id: "LIVE-A",
            ticket_id: TICKET,
            prompt: PROMPT,
          }),
          CMD,
        ),
      );
      await vi.waitFor(async () => {
        await started.lifecycle.settled();
        const run = unwrap(await listRuns(t.db, SESSION))[0];
        expect(["ok", "failed", "timeout", "interrupted"]).toContain(
          run?.state,
        );
      }, WAIT);
      const run = unwrap(await listRuns(t.db, SESSION))[0];
      const token = specs[0]?.mcp?.token ?? "";
      const credential = Object.values(secrets)[0] ?? "";

      // `ps` shows the live runner's command line: the mount, never the token.
      const session = unwrap(await getSession(t.db, SESSION));
      const pid = Number(session.executor_ref?.split(":")[1]);
      const ps = execFileSync("ps", ["-o", "command=", "-p", String(pid)], {
        encoding: "utf8",
      });
      const rows = unwrap(
        await getEventsSince(t.db, {
          sessionId: SESSION,
          since: 0,
          limit: 1000,
        }),
      ).rows;
      const init = Init.parse(
        JSON.parse(
          rows.find((r) => r.kind === "session_init")?.payload_json ?? "{}",
        ),
      );
      const calls = rows
        .filter((r) => r.kind === "mcp_call")
        .map((r) => r.tool_name);
      const ticketEvents = unwrap(
        await listTicketEvents(t.db, {
          ticket_id: TICKET,
          since: 0,
          limit: 100,
        }),
      ).rows;
      const logs = filesUnder(
        join(home.path, "runtime", "sessions", SESSION, "logs"),
      ).map((file) => readFileSync(file, "utf8"));
      const audit = unwrap(await listAudit(t.db)).map((a) => a.action);

      const evidence = {
        run_state: run?.state,
        init_mcp_servers: init.mcp_servers,
        mcp_calls: calls,
        ticket_events: ticketEvents.map((e) => ({
          kind: e.kind,
          actor_kind: e.actor_kind,
          actor_id: e.actor_id,
        })),
        audit,
        token_on_ps: ps.includes(token),
        ps_mounts_mcp: ps.includes("--mcp-config"),
        token_in_logs: logs.some((text) => text.includes(token)),
        credential_in_logs: logs.some((text) => text.includes(credential)),
      };
      console.log(
        `live MCP run evidence: ${JSON.stringify(evidence, null, 2)}`,
      );

      expect(run?.state).toBe("ok");
      expect(token).not.toBe("");
      expect(init.mcp_servers).toContainEqual(
        expect.objectContaining({ name: "foreman", status: "connected" }),
      );
      expect(calls).toContain("ticket_get");
      expect(ticketEvents).toContainEqual(
        expect.objectContaining({
          kind: "comment",
          actor_kind: "session",
          actor_id: SESSION,
        }),
      );
      expect(audit).toContain("mcp.ticket_comment");
      expect(evidence.ps_mounts_mcp).toBe(true);
      expect(evidence.token_on_ps).toBe(false);
      expect(evidence.token_in_logs).toBe(false);
      expect(evidence.credential_in_logs).toBe(false);
    });
  },
);
