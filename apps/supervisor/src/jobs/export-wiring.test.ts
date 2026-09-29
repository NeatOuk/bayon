// Drives a real supervisor (startSupervisor, real ingest, real lifecycle) through to a real
// terminal event, proving the code review's CRITICAL is fixed: without wireExporter's
// ingest.onTerminal subscription, an export run's terminal commits but ticket_exports is never
// written. The second test proves that directly, by wiring everything wireExporter does *except*
// the subscription and showing ticket_exports stays empty.
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import { getSession, listNeedsAttention, listTicketExports } from "@bayon/db";
import { seedRows, tempDb, unwrap } from "@bayon/db/testing";
import { SlotCounter } from "@bayon/executors";
import { FakeExecutor, type FakeIo } from "@bayon/executors/testing";
import {
  createScriptAdapter,
  emit,
  readGo,
  readOps,
} from "@bayon/runners/script";
import { pino } from "pino";
import { afterEach, expect, test } from "vitest";
import { upsertBootRows } from "../boot.js";
import { envSecrets, lifecycleFactory } from "../lifecycle/index.js";
import { startSupervisor, type Supervisor } from "../supervisor.js";
import {
  EXPORTER_AGENT_ID,
  EXPORTER_ROLE,
  EXPORTER_RUN_CLASS,
} from "./export-agent.js";
import { spawnExporter, wireExporter } from "./export-wiring.js";

const clock = new FakeClock(1_700_000_000_000);
const log = pino({ level: "silent" });
const EXECUTOR_ID = "fake-exporter-executor";
const RUNNER_ID = "script-test-exporter";
const PROFILE_ID = "exporter-profile";

let dir: string | undefined;
let dropDb: (() => void) | undefined;
let supervisor: Supervisor | undefined;
afterEach(async () => {
  try {
    await supervisor?.shutdown();
  } finally {
    supervisor = undefined;
    // The test's own handle on its temp database: closed, and the directory removed.
    dropDb?.();
    dropDb = undefined;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  }
});

/**
 * A test-only io.ts-speaking program: waits for `send`, writes a manifest, emits `terminal` with
 * `outcome` and a `manifest_path` pointing at it -- exactly the shape the real export-markdown.ts
 * job produces, minus the actual rendering/git work. `manifestPath` is a path the test itself
 * created (not `io.cwd`: a `workspace_id: null` agent's session root is never materialized on disk
 * under FakeExecutor, since `FakeExecutor.prepare` is a no-op -- real only under LocalExecutor).
 */
function testExportProgram(outcome: "ok" | "failed", manifestPath: string) {
  return async (io: FakeIo): Promise<number> => {
    const ops = readOps(io.stdin);
    const go = await readGo(ops);
    if (go !== undefined) {
      emit(io, {
        kind: "session_init",
        runner_type: "test.init",
        payload: { runner_session_id: "rs-1" },
      });
      writeFileSync(
        manifestPath,
        JSON.stringify({
          v: 1,
          entries: [
            {
              ticket_id: "tkt-wiring-1",
              target: "markdown",
              path: "tickets/T-1.md",
              content_hash: "a".repeat(64),
            },
          ],
          removed: [],
        }),
      );
      emit(io, {
        kind: "terminal",
        runner_type: "test.terminal",
        payload: { outcome, manifest_path: manifestPath },
      });
    }
    for (;;) {
      const next = await ops.next();
      if (next.done === true) return 0;
    }
  };
}

/** A real startSupervisor over a FakeExecutor running `testExportProgram`, with the exporter's
 * agent/profile/executor/run_class config seeded. Returns the session id once its process has
 * started (not yet run). */
async function bootWithExporter(outcome: "ok" | "failed") {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "frm-export-wiring-")));
  const t = unwrap(await tempDb(clock));
  dropDb = t.cleanup;
  const home = join(dir, "home");
  const manifestPath = join(dir, "export-manifest.json");
  const slots = new SlotCounter(4);
  const executor = new FakeExecutor({
    id: EXECUTOR_ID,
    slots,
    programs: {
      "test-export": testExportProgram(outcome, manifestPath),
      // The health probe's default argv is real node (§9.6 step 7); a fake one needs its own.
      ok: () => 0,
    },
  });
  const exportAdapter = createScriptAdapter({
    id: RUNNER_ID,
    argv: ["test-export"],
  });
  const lifecycle = lifecycleFactory({
    executors: new Map([[EXECUTOR_ID, { executor, slots }]]),
    adapters: new Map([[RUNNER_ID, exportAdapter]]),
    secrets: envSecrets({}),
    // The exporter is the daemon's own job runner, as main.ts declares it: exempt from
    // admission's `uncertified` gate only.
    jobRunners: new Set([RUNNER_ID]),
  });
  const started = unwrap(
    await startSupervisor({
      home,
      dbPath: t.path,
      clock,
      log,
      version: "test",
      lifecycle,
    }),
  );
  supervisor = started;

  // The runner+model rows before anything that references RUNNER_ID by foreign key: wireExporter
  // does this too (idempotently), but profiles/agents below need it to already exist.
  unwrap(
    await upsertBootRows(started.db, {
      registrations: [exportAdapter.registration()],
    }),
  );

  unwrap(
    await seedRows(t.db, {
      executors: [
        {
          id: EXECUTOR_ID,
          kind: "local",
          config_json: JSON.stringify({ healthArgv: ["ok"] }),
        },
      ],
      run_classes: [
        {
          name: EXPORTER_RUN_CLASS,
          context_tokens_cap: 0,
          max_turns: 0,
          max_tool_calls: 0,
          wall_clock_ms: 60_000,
          cost_cap_usd: 0,
          handoff_at_turns: 0,
          default_tier: "cheap",
        },
      ],
      profiles: [
        {
          id: PROFILE_ID,
          name: PROFILE_ID,
          runner_id: RUNNER_ID,
          model_tier: "cheap",
          version: 1,
          hash: "0".repeat(64),
          created_at: clock.now(),
        },
      ],
      tickets: [
        {
          id: "tkt-wiring-1",
          num: 1,
          title: "wiring test ticket",
          type: "chore",
          status: "backlog",
          origin: "operator",
          created_at: clock.now(),
          updated_at: clock.now(),
        },
      ],
      agents: [
        {
          id: EXPORTER_AGENT_ID,
          name: EXPORTER_AGENT_ID,
          kind: "util",
          runner_id: RUNNER_ID,
          executor_id: EXECUTOR_ID,
          profile_id: PROFILE_ID,
          workspace_id: null,
          created_at: clock.now(),
        },
      ],
    }),
  );
  return started;
}

test("wireExporter: an export run through a real supervisor populates ticket_exports", async () => {
  const sup = await bootWithExporter("ok");
  const wiring = await wireExporter({
    supervisor: sup,
    log,
    clock,
    exportAdapter: createScriptAdapter({
      id: RUNNER_ID,
      argv: ["test-export"],
    }),
  });
  try {
    unwrap(
      await sup.lifecycle.spawn({
        session_id: "01WIRINGOK00000000000001",
        agent_id: EXPORTER_AGENT_ID,
        role: EXPORTER_ROLE,
        run_class: EXPORTER_RUN_CLASS,
        prompt: "go",
      }),
    );
    await expect
      .poll(
        async () =>
          unwrap(await listTicketExports(sup.db, "tkt-wiring-1")).length,
        { timeout: 5_000 },
      )
      .toBe(1);
    const exports = unwrap(await listTicketExports(sup.db, "tkt-wiring-1"));
    expect(exports).toEqual([
      expect.objectContaining({ ticket_id: "tkt-wiring-1", state: "synced" }),
    ]);
  } finally {
    wiring.stop();
  }
});

test("spawnExporter, as export.run and the interval timer call it, starts the export run", async () => {
  // The other tests here spawn with a prompt of their own; both real triggers go through
  // spawnExporter. A session spawned without a prompt starts no run, so the job never hears `go`
  // and nothing is exported (found by the M1 smoke).
  const sup = await bootWithExporter("ok");
  const wiring = await wireExporter({
    supervisor: sup,
    log,
    clock,
    exportAdapter: createScriptAdapter({
      id: RUNNER_ID,
      argv: ["test-export"],
    }),
  });
  try {
    unwrap(await spawnExporter(sup, clock)());
    await expect
      .poll(
        async () =>
          unwrap(await listTicketExports(sup.db, "tkt-wiring-1")).length,
        { timeout: 5_000 },
      )
      .toBe(1);
  } finally {
    wiring.stop();
  }
}, 15_000); // above the poll's own deadline, so a failure reports the poll's assertion

test("wireExporter: a failed export run yields an export_failed attention row", async () => {
  const sup = await bootWithExporter("failed");
  const wiring = await wireExporter({
    supervisor: sup,
    log,
    clock,
    exportAdapter: createScriptAdapter({
      id: RUNNER_ID,
      argv: ["test-export"],
    }),
  });
  try {
    unwrap(
      await sup.lifecycle.spawn({
        session_id: "01WIRINGFAIL0000000001",
        agent_id: EXPORTER_AGENT_ID,
        role: EXPORTER_ROLE,
        run_class: EXPORTER_RUN_CLASS,
        prompt: "go",
      }),
    );
    await expect
      .poll(
        async () =>
          unwrap(await listTicketExports(sup.db, "tkt-wiring-1"))[0]?.state,
        { timeout: 5_000 },
      )
      .toBe("failed");
    const attention = unwrap(await listNeedsAttention(sup.db));
    expect(
      attention.some(
        (a) => a.why === "export_failed" && a.ticket_id === "tkt-wiring-1",
      ),
    ).toBe(true);
  } finally {
    wiring.stop();
  }
});

test("without the onTerminal subscription, the same run leaves ticket_exports empty", async () => {
  // bootWithExporter already registers the runner (profiles/agents need it by foreign key) and
  // seeds the exporter's config -- exactly what a daemon that forgot wireExporter's subscription
  // would still have, since the registration and the subscription are two different lines.
  const sup = await bootWithExporter("ok");
  const sessionId = "01WIRINGNOSUB000000001";
  unwrap(
    await sup.lifecycle.spawn({
      session_id: sessionId,
      agent_id: EXPORTER_AGENT_ID,
      role: EXPORTER_ROLE,
      run_class: EXPORTER_RUN_CLASS,
      prompt: "go",
    }),
  );
  // Wait for the run to genuinely finish (session leaves `running`) -- a fact independent of
  // whether anything is subscribed to onTerminal -- before checking that nothing reacted to it.
  await expect
    .poll(async () => unwrap(await getSession(sup.db, sessionId)).state, {
      timeout: 5_000,
    })
    .not.toBe("running");
  expect(unwrap(await listTicketExports(sup.db, "tkt-wiring-1"))).toEqual([]);
});
