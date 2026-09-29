// A conformance run against a model the provider does not serve: opencode's stand-in,
// the real local executor, and a stand-in provider on 127.0.0.1 that serves another model. The run
// is refused in seconds, naming the model and the host, and no test runs.
import { systemClock } from "@bayon/core";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import { afterAll, beforeAll, expect, test } from "vitest";
import { FaultExecutor } from "../../conformance/fault-executor.js";
import { createReferencePorts } from "../../conformance/reference.js";
import { runConformance } from "../../conformance/suite.js";
import { LIVE_BUDGETS } from "../../conformance/types.js";
import { startFakeUpstream, type FakeUpstream } from "../../fake-upstream.js";
import { createOpencodeAdapter } from "./adapter.js";
import { OPENCODE_KIT } from "./conformance.js";
import { OLLAMA_BASE_URL_ENV } from "./registration.js";
import { CHEAP_MODEL } from "./testing/cheap-model.js";
import { STUB_OPENCODE } from "./testing/stub.js";

let upstream: FakeUpstream;
beforeAll(async () => {
  upstream = await startFakeUpstream((req, _body, res) => {
    const text = JSON.stringify({ data: [{ id: "renamed-model:27b" }] });
    if (req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(text);
      return;
    }
    res.writeHead(404, { "content-length": "0" });
    res.end();
  });
});
afterAll(() => upstream.close());

test("a model the provider does not serve fails in seconds, naming model and host", async () => {
  // The live budgets: the refusal must not lean on the offline suite's short call deadline.
  const budgets = LIVE_BUDGETS;
  const ports = await createReferencePorts({ clock: systemClock, budgets });
  const t0 = Date.now();
  try {
    const result = await runConformance(
      {
        adapter: createOpencodeAdapter({
          bin: [process.execPath, STUB_OPENCODE],
          graceMs: budgets.graceMs,
          ...(process.platform === "darwin" ? {} : { unsandboxed: true }),
        }),
        kit: OPENCODE_KIT,
        executor: new FaultExecutor(
          new LocalExecutor({ id: "local", slots: new SlotCounter(8) }),
        ),
        env: {
          PATH: process.env["PATH"] ?? "",
          [OLLAMA_BASE_URL_ENV]: `${upstream.url}/v1`,
        },
        model: CHEAP_MODEL,
      },
      ports,
      { budgets },
    );
    const id = CHEAP_MODEL.slice(CHEAP_MODEL.indexOf("/") + 1);
    expect(result).toEqual({
      ok: false,
      error: {
        class: "runner_error",
        message: `model ${id} not served by 127.0.0.1:${upstream.port} (it serves: renamed-model:27b)`,
        retryable: false,
      },
    });
  } finally {
    await ports.workspace.dispose();
  }
  expect(Date.now() - t0).toBeLessThan(5_000);
  // One question, and not one chat call.
  expect(upstream.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
    "GET /v1/models",
  ]);
});
