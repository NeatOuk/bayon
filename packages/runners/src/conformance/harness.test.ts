// Where the harness's sessions live: the spawn pipeline's order (place, prepare, create),
// what the executor prepared applied to the spec, a session closed early or at teardown released
// once and after its stop, never more than SUITE_PEAK_SESSIONS sessions at once, and test 1's
// health placed only where the executor places sessions.
import { systemClock } from "@bayon/core";
import {
  SlotCounter,
  type Prepared,
  type PrepareSpec,
  type SessionPlace,
} from "@bayon/executors";
import { FakeExecutor } from "@bayon/executors/testing";
import { expect, test } from "vitest";
import type { HealthPlace, RunnerAdapter } from "../adapter.js";
import { FIXTURE_KIT } from "../adapters/fixture/conformance.js";
import {
  FIXTURE_PROGRAM,
  createFixtureAdapter,
  fixtureProgram,
} from "../adapters/fixture/index.js";
import { FaultExecutor } from "./fault-executor.js";
import { SuiteCtx } from "./harness.js";
import { createReferencePorts } from "./reference.js";
import { runConformance } from "./suite.js";
import {
  OFFLINE_BUDGETS,
  SUITE_PEAK_SESSIONS,
  type Budgets,
  type ConformancePorts,
} from "./types.js";

const BUDGETS: Budgets = { ...OFFLINE_BUDGETS, callMs: 2_000, turnMs: 5_000 };
const GATEWAY = "frm-ctr-gateway";
const MCP_URL = `http://${GATEWAY}:3010/mcp`;
const PROXY = `http://${GATEWAY}:8888`;

/** A fake executor that prepares a gateway and a proxy, logging each prepare; optionally placing. */
class Gatewayed extends FakeExecutor {
  readonly log: string[];
  envPath?: string;
  placeSession?: (sessionId: string) => SessionPlace;

  constructor(log: string[], placing = false) {
    super({
      programs: { [FIXTURE_PROGRAM]: fixtureProgram },
      slots: new SlotCounter(8),
    });
    this.log = log;
    if (placing) {
      this.envPath = "/image/bin";
      this.placeSession = (sid) => ({
        root: `/placed/${sid}`,
        home: `/placed/${sid}/home`,
        tmp: `/placed/${sid}/tmp`,
      });
    }
  }

  override async prepare(spec: PrepareSpec): Promise<Prepared> {
    this.log.push("prepare");
    return { root: spec.root, mcpUrl: MCP_URL, proxyUrl: PROXY };
  }
}

const fixture = () =>
  createFixtureAdapter({ command: [FIXTURE_PROGRAM], graceMs: 200 });

/** The reference ports, the workspace logging place, create and release. */
async function loggedPorts(log: string[]): Promise<ConformancePorts> {
  const ports = await createReferencePorts({
    clock: systemClock,
    budgets: BUDGETS,
  });
  const w = ports.workspace;
  return {
    ...ports,
    workspace: {
      ...w,
      place: async (sid) => {
        log.push("place");
        return w.place(sid);
      },
      create: async (sid) => {
        log.push("create");
        return w.create(sid);
      },
      release: async (sid) => {
        log.push(`release ${sid}`);
      },
    },
  };
}

function ctxOf(
  log: string[],
  adapter: RunnerAdapter,
  ports: ConformancePorts,
): SuiteCtx {
  return new SuiteCtx(
    {
      adapter,
      kit: FIXTURE_KIT,
      model: "fixture-model",
      executor: new FaultExecutor(new Gatewayed(log)),
      env: {},
    },
    ports,
    BUDGETS,
  );
}

test("open places, prepares, then creates, and applies what the executor prepared", async () => {
  const log: string[] = [];
  const ports = await loggedPorts(log);
  try {
    const ctx = ctxOf(log, fixture(), ports);
    const live = await ctx.open({
      scenario: "plain",
      mcp: { url: "http://127.0.0.1:1/mcp", token: "t", tools: [] },
    });
    expect(log).toEqual(["place", "prepare", "create"]);
    expect(live.spec.mcp?.url).toBe(MCP_URL);
    expect(live.spec.env).toMatchObject({
      HTTPS_PROXY: PROXY,
      NO_PROXY: `localhost,127.0.0.1,${GATEWAY}`,
    });
    expect(await ctx.teardown()).toEqual([]);
    expect(log.at(-1)).toBe(`release ${live.sessionId}`);
  } finally {
    await ports.workspace.dispose();
  }
});

test("close stops, then releases, once; teardown releases the rest once", async () => {
  const log: string[] = [];
  const ports = await loggedPorts(log);
  const fx = fixture();
  const adapter: RunnerAdapter = {
    ...fx,
    stop: async (h, mode) => {
      log.push("stop");
      return fx.stop(h, mode);
    },
  };
  try {
    const ctx = ctxOf(log, adapter, ports);
    const a = await ctx.open({ scenario: "plain" });
    await a.spawn();
    const b = await ctx.open({ scenario: "plain" });
    await ctx.close(a);
    expect(log.slice(-2)).toEqual(["stop", `release ${a.sessionId}`]);
    expect(await ctx.teardown()).toEqual([]);
    expect(log.filter((l) => l.startsWith("release"))).toEqual([
      `release ${a.sessionId}`,
      `release ${b.sessionId}`,
    ]);
  } finally {
    await ports.workspace.dispose();
  }
});

test(
  "the whole suite never holds more than SUITE_PEAK_SESSIONS sessions at once",
  { timeout: 60_000 },
  async () => {
    const ports = await createReferencePorts({
      clock: systemClock,
      budgets: BUDGETS,
    });
    const w = ports.workspace;
    let held = 0;
    let peak = 0;
    try {
      const result = await runConformance(
        {
          adapter: fixture(),
          kit: FIXTURE_KIT,
          model: "fixture-model",
          executor: new FaultExecutor(new Gatewayed([])),
          env: {},
        },
        {
          ...ports,
          workspace: {
            ...w,
            place: async (sid) => {
              held += 1;
              peak = Math.max(peak, held);
              return w.place(sid);
            },
            release: async () => {
              held -= 1;
            },
          },
        },
        { budgets: BUDGETS },
      );
      expect(result.ok).toBe(true);
      expect(peak).toBe(SUITE_PEAK_SESSIONS);
      expect(held).toBe(0);
    } finally {
      await w.dispose();
    }
  },
);

test("test 1 checks health in a placed session only where the executor places sessions", async () => {
  for (const placing of [false, true]) {
    const ports = await createReferencePorts({
      clock: systemClock,
      budgets: BUDGETS,
    });
    const seen: (HealthPlace | undefined)[] = [];
    const fx = fixture();
    const adapter: RunnerAdapter = {
      ...fx,
      health: (ex, at) => {
        seen.push(at);
        return fx.health(ex, at);
      },
    };
    try {
      const r = await runConformance(
        {
          adapter,
          kit: FIXTURE_KIT,
          model: "fixture-model",
          executor: new FaultExecutor(new Gatewayed([], placing)),
          env: {},
        },
        ports,
        { budgets: BUDGETS, only: [1] },
      );
      expect(r.ok && r.value.tests[0]?.status).toBe("pass");
      expect(seen).toHaveLength(1);
      if (placing) {
        expect(seen[0]).toEqual({
          cwd: expect.any(String),
          tmp: expect.any(String),
        });
      } else {
        expect(seen[0]).toBeUndefined();
      }
    } finally {
      await ports.workspace.dispose();
    }
  }
});

test("FaultExecutor forwards the real executor's PATH and session places, and only those it has", () => {
  const inner = new Gatewayed([], true);
  const f = new FaultExecutor(inner);
  expect(f.envPath).toBe("/image/bin");
  expect(f.placeSession?.("S1")).toEqual(inner.placeSession?.("S1"));
  const bare = new FaultExecutor(new Gatewayed([]));
  expect(bare.envPath).toBeUndefined();
  expect(bare.placeSession).toBeUndefined();
});
