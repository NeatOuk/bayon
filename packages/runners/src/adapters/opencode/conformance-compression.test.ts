// The whole conformance suite with context compression on (spec M12), on opencode's
// stand-in through the real turn host, the real local executor and (on macOS) the real Seatbelt
// profile, the provider an echo upstream: every session behind its own proxy, and test 17 on top.
// The stand-in's model calls reach the proxy from inside the sandbox, which proves its port is open.
import {
  CONTEXT_RULESET,
  systemClock,
  type ConformanceResult,
} from "@bayon/core";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { afterAll, beforeAll, expect, test } from "vitest";
import { FaultExecutor } from "../../conformance/fault-executor.js";
import { runUnderLoad } from "../../conformance/fixtures.js";
import { createReferencePorts } from "../../conformance/reference.js";
import { kitHash, runConformance } from "../../conformance/suite.js";
import type { Budgets } from "../../conformance/types.js";
import {
  echo,
  startFakeUpstream,
  type FakeUpstream,
} from "../../fake-upstream.js";
import { createOpencodeAdapter } from "./adapter.js";
import { OPENCODE_KIT } from "./conformance.js";
import { CHEAP_MODEL } from "./testing/cheap-model.js";
import { STUB_OPENCODE } from "./testing/stub.js";

let upstream: FakeUpstream;
beforeAll(async () => {
  // The suite asks the provider first whether it serves the model; every other
  // request is echoed, as before.
  const id = CHEAP_MODEL.slice(CHEAP_MODEL.indexOf("/") + 1);
  upstream = await startFakeUpstream((req, body, res) => {
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id }] }));
      return;
    }
    echo(req, body, res);
  });
});
afterAll(() => upstream.close());

async function suiteOnStub(budgets: Budgets): Promise<ConformanceResult> {
  const ports = await createReferencePorts({ clock: systemClock, budgets });
  try {
    const result = await runConformance(
      {
        adapter: createOpencodeAdapter({
          bin: [process.execPath, STUB_OPENCODE],
          graceMs: budgets.graceMs,
          contextLog: () => undefined,
          ...(process.platform === "darwin" ? {} : { unsandboxed: true }),
        }),
        kit: OPENCODE_KIT,
        executor: new FaultExecutor(
          new LocalExecutor({ id: "local", slots: new SlotCounter(8) }),
        ),
        env: {
          PATH: process.env["PATH"] ?? "",
          OLLAMA_BASE_URL: `${upstream.url}/v1`,
        },
        model: CHEAP_MODEL,
      },
      ports,
      { budgets, compression: true },
    );
    if (!result.ok) throw new Error(result.error.message);
    return result.value;
  } finally {
    await ports.workspace.dispose();
  }
}

test(
  "opencode on its stub with compression: 1–17 pass, 12 and 16 N/A as without",
  { timeout: 300_000 },
  async () => {
    const result = await runUnderLoad(suiteOnStub);
    const failed = result.tests
      .filter((t) => t.status !== "pass" && t.status !== "na")
      .map((t) => ({
        id: t.id,
        status: t.status,
        checks: t.checks.filter((c) => !c.ok),
      }));
    expect(failed).toEqual([]);
    expect(result.tests.map((t) => `${t.id} ${t.status}`)).toEqual([
      "1 pass",
      "2 pass",
      "3 pass",
      "4 pass",
      "5 pass",
      "6 pass",
      "7 pass",
      "8 pass",
      "9 pass",
      "10 pass",
      "11 pass",
      "12 na",
      "13 pass",
      "14 pass",
      "15 pass",
      "16 na",
      "17 pass",
    ]);
    expect(result.compression).toEqual({ ruleset: CONTEXT_RULESET });
    expect(result.kit_hash).toBe(
      await kitHash(
        OPENCODE_KIT,
        CHEAP_MODEL,
        {},
        { ruleset: CONTEXT_RULESET },
      ),
    );
    expect(result.kit_hash).not.toBe(await kitHash(OPENCODE_KIT, CHEAP_MODEL));
    // Every call reached the provider through a proxy, the bearer never with it.
    const calls = upstream.requests.filter(
      (r) => r.url === "/v1/chat/completions",
    );
    expect(calls.length).toBeGreaterThan(16);
    expect(calls.every((r) => r.headers["x-frm-proxy"] === undefined)).toBe(
      true,
    );
  },
);

test("the kit hashes as before M12 with compression off", async () => {
  // Pinned from before this change: a compression-off certificate keeps its hash.
  expect(await kitHash(OPENCODE_KIT, "m-1")).toBe(
    "sha256:8d872eba93bd0bf4c37666ca30285db3e78f343c3c49895af2dfeaf3462b624a",
  );
});
