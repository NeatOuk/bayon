// The stub-drivable conformance subset with context compression on (spec M12), plus test
// 17, through the real SDK, the real local executor and a real proxy per session, the provider an
// echo upstream: the stand-in finds the proxy through the pinned base URL and its bearer in the
// headers env, as the CLI does, and plays the model from what the proxy forwarded.
import { CONTEXT_RULESET, systemClock } from "@bayon/core";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { afterAll, beforeAll, expect, test } from "vitest";
import { FaultExecutor } from "../../conformance/fault-executor.js";
import { statuses } from "../../conformance/fixtures.js";
import { createReferencePorts } from "../../conformance/reference.js";
import { kitHash, runConformance } from "../../conformance/suite.js";
import { OFFLINE_BUDGETS, type Budgets } from "../../conformance/types.js";
import { startFakeUpstream, type FakeUpstream } from "../../fake-upstream.js";
import { createClaudeSdkAdapter } from "./adapter.js";
import { CLAUDE_SDK_KIT } from "./conformance.js";
import { CHEAP_MODEL } from "./testing/cheap-model.js";
import { CLAUDE_SDK_STUB_KIT } from "./testing/conformance-stub.js";
import { STUB_CLI } from "./testing/stub.js";

const BUDGETS: Budgets = {
  ...OFFLINE_BUDGETS,
  callMs: 20_000,
  turnMs: 20_000,
  hangMs: 2_000,
  graceMs: 500,
};

let upstream: FakeUpstream;
beforeAll(async () => {
  upstream = await startFakeUpstream();
});
afterAll(() => upstream.close());

test(
  "claude-sdk on its stub CLI with compression passes 1, 2, 3, 7, 9, 10, 13, 14 and 17",
  { timeout: 180_000 },
  async () => {
    const ports = await createReferencePorts({
      clock: systemClock,
      budgets: BUDGETS,
    });
    try {
      const result = await runConformance(
        {
          adapter: createClaudeSdkAdapter({
            pathToExecutable: STUB_CLI,
            executable: "node",
            graceMs: 500,
            contextLog: () => undefined,
          }),
          kit: CLAUDE_SDK_STUB_KIT,
          model: CHEAP_MODEL,
          executor: new FaultExecutor(
            new LocalExecutor({ id: "local", slots: new SlotCounter(8) }),
          ),
          // The operator's base URL: the proxy's upstream.
          env: {
            PATH: process.env["PATH"] ?? "",
            ANTHROPIC_BASE_URL: upstream.url,
          },
        },
        ports,
        {
          budgets: BUDGETS,
          only: [1, 2, 3, 7, 9, 10, 13, 14, 17],
          compression: true,
        },
      );
      if (!result.ok) throw new Error(result.error.message);
      const t17 = result.value.tests.find((t) => t.id === 17);
      expect(t17?.checks.filter((c) => !c.ok)).toEqual([]);
      expect(
        statuses(result.value).filter(
          (s) => !s.endsWith("not_run not in options.only"),
        ),
      ).toEqual([
        "1 pass",
        "2 pass",
        "3 pass",
        "7 pass",
        "9 pass",
        "10 pass",
        "13 pass",
        "14 pass",
        "17 pass",
      ]);
      expect(result.value.compression).toEqual({ ruleset: CONTEXT_RULESET });
      expect(result.value.kit_hash).toBe(
        await kitHash(
          CLAUDE_SDK_STUB_KIT,
          CHEAP_MODEL,
          {},
          {
            ruleset: CONTEXT_RULESET,
          },
        ),
      );
      const calls = upstream.requests.filter((r) =>
        r.url.startsWith("/v1/messages"),
      );
      expect(calls.length).toBeGreaterThanOrEqual(5);
      expect(calls.every((r) => r.headers["x-frm-proxy"] === undefined)).toBe(
        true,
      );
    } finally {
      await ports.workspace.dispose();
    }
  },
);

test("a runner that does not compress on the executor is refused before any test", async () => {
  const ports = await createReferencePorts({
    clock: systemClock,
    budgets: BUDGETS,
  });
  try {
    const adapter = createClaudeSdkAdapter({ pathToExecutable: STUB_CLI });
    const result = await runConformance(
      {
        adapter: { ...adapter, compressesContext: () => false },
        kit: CLAUDE_SDK_STUB_KIT,
        model: CHEAP_MODEL,
        executor: new FaultExecutor(
          new LocalExecutor({ id: "local", slots: new SlotCounter(8) }),
        ),
        env: {},
      },
      ports,
      { budgets: BUDGETS, compression: true },
    );
    expect(result.ok ? "ran" : result.error.message).toMatch(
      /does not compress context on a local executor/,
    );
  } finally {
    await ports.workspace.dispose();
  }
});

test("the kit hashes as before M12 with compression off; on, it pins the ruleset and test 17", async () => {
  // Pinned from before this change: a compression-off certificate keeps its hash.
  expect(await kitHash(CLAUDE_SDK_KIT, "m-1")).toBe(
    "sha256:a32df20d03825dc0c24875e61d0e6f52ec8b82f84615e246e560b26328411582",
  );
  expect(
    await kitHash(CLAUDE_SDK_KIT, "m-1", {}, { ruleset: CONTEXT_RULESET }),
  ).not.toBe(await kitHash(CLAUDE_SDK_KIT, "m-1"));
});
