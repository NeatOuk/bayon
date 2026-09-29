// a conformance run leaves no process behind. On the Mac, the two-session half of the
// old test 14 spawned both at once; with an OAuth login (CODEX_AUTH_JSON) the second spawn was
// refused at once (one live session holds auth.json), Promise.all rejected, and teardown ran while
// the first spawn was still starting: its session had no handle yet, so nothing stopped it. That
// turn host then wrote its home into the tree the supervisor was removing (ENOTEMPTY) and was
// orphaned. That half is test 15 now, and this runner reports it N/A, so the race is
// staged here against an adapter that declares `concurrentSessions` while its credential serves
// one: the backstop refuses the second spawn exactly as it did. And the slow end: a stop ends the
// turn host, but a member of its process group (a tool's child) can write on into the home after
// it.
import { CHEAP_MODEL } from "./testing/cheap-model.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { systemClock } from "@bayon/core";
import {
  LocalExecutor,
  SlotCounter,
  type Argv,
  type ExecOpts,
  type Proc,
} from "@bayon/executors";
import { expect, test } from "vitest";
import type { RunnerAdapter } from "../../adapter.js";
import { FaultExecutor } from "../../conformance/fault-executor.js";
import { SuiteCtx } from "../../conformance/harness.js";
import { createReferencePorts } from "../../conformance/reference.js";
import { runConformance } from "../../conformance/suite.js";
import { OFFLINE_BUDGETS, type Budgets } from "../../conformance/types.js";
import { createCodexExecAdapter } from "./adapter.js";
import { CODEX_EXEC_KIT } from "./conformance.js";
import { AUTH_JSON_ENV, CODEX_DIR } from "./home.js";
import { STUB_CODEX } from "./testing/stub.js";

const BUDGETS: Budgets = {
  ...OFFLINE_BUDGETS,
  callMs: 10_000,
  turnMs: 10_000,
  graceMs: 500,
};

/** The local executor, recording the ref of every process it starts. */
class Recording extends LocalExecutor {
  readonly refs: string[] = [];

  override async exec(argv: Argv, opts: ExecOpts): Promise<Proc> {
    const proc = await super.exec(argv, opts);
    this.refs.push(proc.ref);
    return proc;
  }
}

test(
  "teardown waits for the session's whole process group: a member outliving its turn host is killed first",
  { timeout: 60_000 },
  async () => {
    const local = new Recording({ id: "local", slots: new SlotCounter(8) });
    const fault = new FaultExecutor(local);
    const ports = await createReferencePorts({
      clock: systemClock,
      budgets: BUDGETS,
    });
    const ctx = new SuiteCtx(
      {
        adapter: createCodexExecAdapter({
          bin: [process.execPath, STUB_CODEX],
          graceMs: BUDGETS.graceMs,
        }),
        kit: CODEX_EXEC_KIT,
        model: CHEAP_MODEL,
        executor: fault,
        env: { PATH: process.env["PATH"] ?? "" },
      },
      ports,
      BUDGETS,
    );
    try {
      // Each turn leaves a member in the host's group that takes no signal but SIGKILL and keeps
      // writing into the home for a minute: the stop ends the host, not its group.
      const live = await ctx.open({
        scenario: "plain",
        env: { FRM_STUB_LINGER_MS: "60000" },
      });
      await live.spawn();
      const host = live.handle.executorRef;
      const end = await live.run(live.turn(0));
      expect(end.watch.by).toBe("terminal");
      expect(
        existsSync(join(live.dirs.homeDir, CODEX_DIR, "stub", "linger.pid")),
      ).toBe(true);
      expect(await ctx.teardown()).toEqual([]);
      // Read at once: teardown returned only after the last member of the group was gone.
      expect(await local.probe(host)).toBe("dead");
    } finally {
      await fault.end(systemClock, BUDGETS.callMs);
      await ports.workspace.dispose();
    }
  },
);

test(
  "a spawn still starting when its test fails is stopped before the suite returns",
  { timeout: 60_000 },
  async () => {
    const local = new Recording({ id: "local", slots: new SlotCounter(8) });
    const codex = createCodexExecAdapter({
      bin: [process.execPath, STUB_CODEX],
      graceMs: BUDGETS.graceMs,
    });
    const starting = new Set<Promise<unknown>>();
    const adapter: RunnerAdapter = {
      ...codex,
      // Declared, so test 15 opens the two sessions the credential cannot serve: what admission
      // would have queued reaches the adapter, and its backstop refuses it mid-flight.
      caps: () => ({ ...codex.caps(), concurrentSessions: true }),
      spawn: (spec, ex) => {
        const p = codex.spawn(spec, ex);
        starting.add(p);
        void p.finally(() => starting.delete(p));
        return p;
      },
    };
    const ports = await createReferencePorts({
      clock: systemClock,
      budgets: BUDGETS,
    });
    try {
      const result = await runConformance(
        {
          adapter,
          kit: CODEX_EXEC_KIT,
          model: CHEAP_MODEL,
          executor: new FaultExecutor(local),
          env: {
            PATH: process.env["PATH"] ?? "",
            [AUTH_JSON_ENV]: JSON.stringify({ stub: "not a credential" }),
          },
        },
        ports,
        { budgets: BUDGETS, only: [15] },
      );
      // The race was run: test 15's second spawn was refused while the first was starting.
      if (!result.ok) throw new Error(result.error.message);
      const t15 = result.value.tests.find((t) => t.id === 15);
      expect(t15?.checks.find((c) => !c.ok)).toMatchObject({
        name: "spawn",
        detail: expect.stringContaining("auth.json"),
      });
      // Nothing of the run is still starting, and nothing it started is alive.
      expect(starting.size).toBe(0);
      await Promise.allSettled([...starting]);
      const states = await Promise.all(local.refs.map((r) => local.probe(r)));
      expect(states.filter((s) => s !== "dead")).toEqual([]);
    } finally {
      await Promise.allSettled([...starting]);
      for (const ref of local.refs) {
        await local.cleanup(ref, "hard").catch(() => undefined);
      }
      await ports.workspace.dispose();
    }
  },
);
