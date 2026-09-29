// opencode's model pre-flight against a stand-in provider on 127.0.0.1: no real network.
import type { ServerResponse } from "node:http";
import { FakeClock } from "@bayon/core";
import { afterEach, expect, test, vi } from "vitest";
import type { PreflightTarget } from "../../adapter.js";
import {
  startFakeUpstream,
  type FakeUpstream,
  type UpstreamHandler,
} from "../../fake-upstream.js";
import { preflightModel } from "../../preflight.js";
import { createOpencodeAdapter } from "./adapter.js";
import { DEFAULTS, OLLAMA_BASE_URL_ENV } from "./registration.js";

const opened: FakeUpstream[] = [];
afterEach(async () => {
  await Promise.all(opened.splice(0).map((u) => u.close()));
});

const json = (res: ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(Buffer.byteLength(text)),
  });
  res.end(text);
};

const notFound = (res: ServerResponse): void => {
  res.writeHead(404, { "content-length": "0" });
  res.end();
};

/** A provider serving `ids` on the OpenAI-compatible list, the Ollama list, or both. */
const provider =
  (
    ids: readonly string[],
    o: { readonly v1?: boolean; readonly tags?: boolean } = {},
  ): UpstreamHandler =>
  (req, _body, res) => {
    if (req.url === "/v1/models" && o.v1 !== false) {
      json(res, 200, {
        object: "list",
        data: ids.map((id) => ({ id, object: "model" })),
      });
    } else if (req.url === "/api/tags" && o.tags !== false) {
      json(res, 200, { models: ids.map((name) => ({ name, model: name })) });
    } else {
      notFound(res);
    }
  };

async function upstream(handler: UpstreamHandler): Promise<FakeUpstream> {
  const u = await startFakeUpstream(handler);
  opened.push(u);
  return u;
}

const adapter = createOpencodeAdapter();

const target = (
  base: string | undefined,
  o: Partial<PreflightTarget> = {},
): PreflightTarget => ({
  model: "ollama/qwen-a:27b",
  flags: { ...DEFAULTS },
  env: base === undefined ? {} : { [OLLAMA_BASE_URL_ENV]: base },
  executorKind: "local",
  ...o,
});

// Time is a FakeClock: the bound fires only when a test advances it, never on the wall clock.
const ask = (t: PreflightTarget, clock = new FakeClock()) =>
  preflightModel(adapter, t, { timeoutMs: 5_000, clock });

test("served: the OpenAI-compatible list names the model", async () => {
  const u = await upstream(provider(["qwen-a:27b", "gemma:9b"]));
  expect(await ask(target(`${u.url}/v1`))).toEqual({ verdict: "served" });
  expect(u.requests.map((r) => `${r.method} ${r.url}`)).toEqual([
    "GET /v1/models",
  ]);
  // Keyless and plain: no header of ours rides on it.
  expect(u.requests[0]?.headers["authorization"]).toBeUndefined();
});

test("served: the Ollama list, when the OpenAI-compatible one does not answer", async () => {
  const u = await upstream(provider(["qwen-a:27b"], { v1: false }));
  expect(await ask(target(`${u.url}/v1`))).toEqual({ verdict: "served" });
  expect(u.requests.map((r) => r.url)).toEqual(["/v1/models", "/api/tags"]);
});

test("served: an untagged model is the provider's :latest", async () => {
  const u = await upstream(provider(["llama-x:latest"]));
  expect(await ask(target(`${u.url}/v1`, { model: "ollama/llama-x" }))).toEqual(
    { verdict: "served" },
  );
});

test("not served: names the model and the provider's host, and what it does serve", async () => {
  const u = await upstream(provider(["qwen-a-iq3:27b", "gemma:9b"]));
  const got = await ask(target(`${u.url}/v1`));
  expect(got).toEqual({
    verdict: "not_served",
    reason: `model qwen-a:27b not served by 127.0.0.1:${u.port} (it serves: qwen-a-iq3:27b, gemma:9b)`,
  });
});

test("not served: a long list is cut", async () => {
  const ids = Array.from({ length: 30 }, (_, i) => `m${i}:1b`);
  const u = await upstream(provider(ids));
  const got = await ask(target(`${u.url}/v1`));
  expect(got.verdict).toBe("not_served");
  const reason = got.verdict === "served" ? "" : got.reason;
  expect(reason).toMatch(/\(it serves: m0:1b, m1:1b, .*, … \+\d+ more\)$/);
  expect(reason.length).toBeLessThanOrEqual(200);
});

test("the model's own provider_url wins over the runner's", async () => {
  const wrong = await upstream(provider([]));
  const right = await upstream(provider(["qwen-a:27b"]));
  expect(
    await ask(
      target(`${wrong.url}/v1`, {
        modelSettings: { provider_url: `${right.url}/v1` },
      }),
    ),
  ).toEqual({ verdict: "served" });
  expect(wrong.requests).toEqual([]);
});

test("unreachable: neither list answers", async () => {
  const u = await upstream((_req, _body, res) => notFound(res));
  const got = await ask(target(`${u.url}/v1`));
  expect(got).toEqual({
    verdict: "unreachable",
    reason: `cannot ask 127.0.0.1:${u.port} which models it serves: /models answered HTTP 404; /api/tags answered HTTP 404`,
  });
});

test("unreachable: a refused connection", async () => {
  const u = await upstream(provider([]));
  const url = u.url;
  await u.close();
  opened.splice(0);
  const got = await ask(target(`${url}/v1`));
  expect(got.verdict).toBe("unreachable");
  expect(got.verdict !== "served" && got.reason).toContain(
    `cannot ask ${new URL(url).host} which models it serves`,
  );
});

test("unreachable: a provider that never answers is cut off at the timeout", async () => {
  const u = await upstream(() => undefined); // holds every request open
  const clock = new FakeClock();
  const pending = ask(target(`${u.url}/v1`), clock);
  await vi.waitFor(() => expect(u.requests).toHaveLength(1));
  await clock.advance(5_000);
  const got = await pending;
  expect(got).toEqual({
    verdict: "unreachable",
    reason: "opencode's model pre-flight got no answer within 5000 ms",
  });
  // Cut off during the first list: the second is never asked.
  expect(u.requests.map((r) => r.url)).toEqual(["/v1/models"]);
});

test("unreachable: a redirect is not followed", async () => {
  const u = await upstream((_req, _body, res) => {
    res.writeHead(302, {
      location: "http://127.0.0.1:1/",
      "content-length": "0",
    });
    res.end();
  });
  const got = await ask(target(`${u.url}/v1`));
  expect(got.verdict).toBe("unreachable");
  expect(got.verdict !== "served" && got.reason).toContain("HTTP 302");
});

test("unchecked: no base URL resolves (the env names none)", async () => {
  expect(await ask(target(undefined))).toEqual({
    verdict: "unchecked",
    reason: `no base URL resolves for provider ollama of model ollama/qwen-a:27b`,
  });
});

test("unchecked: a non-local executor, and nothing is asked", async () => {
  const u = await upstream(provider([]));
  const got = await ask(target(`${u.url}/v1`, { executorKind: "container" }));
  expect(got.verdict).toBe("unchecked");
  expect(u.requests).toEqual([]);
});

test("unchecked: a model that is not provider/model is left to spawn's own refusal", async () => {
  const got = await ask(target("http://127.0.0.1:9/v1", { model: "nope" }));
  expect(got.verdict).toBe("unchecked");
});

test("the host in a reason never carries credentials", async () => {
  const u = await upstream(provider([]));
  const withUser = `http://user:pw@127.0.0.1:${u.port}/v1`;
  const got = await ask(target(withUser));
  expect(got.verdict !== "served" && got.reason).not.toContain("pw");
});

test("an unreachable reason names the request's suffix, never the base path (it may hold a token)", async () => {
  const u = await upstream((_req, _body, res) => notFound(res));
  const got = await ask(target(`${u.url}/sk-TOKEN-0123456789/v1`));
  expect(got).toEqual({
    verdict: "unreachable",
    reason: `cannot ask 127.0.0.1:${u.port} which models it serves: /models answered HTTP 404; /api/tags answered HTTP 404`,
  });
  // The list was asked under the base path, which the reason leaves out.
  expect(u.requests.map((r) => r.url)).toEqual([
    "/sk-TOKEN-0123456789/v1/models",
    "/api/tags",
  ]);
});

test("a base path that starts with // stays a path on the provider's host", async () => {
  const u = await upstream((req, _body, res) => {
    if ((req.url ?? "").endsWith("/models")) {
      json(res, 200, { data: [{ id: "qwen-a:27b" }] });
    } else {
      notFound(res);
    }
  });
  const got = await ask(target(`${u.url}//evil.example/v1`));
  expect(got).toEqual({ verdict: "served" });
  expect(u.requests.map((r) => `${r.headers.host} ${r.url}`)).toEqual([
    `127.0.0.1:${u.port} //evil.example/v1/models`,
  ]);
});
