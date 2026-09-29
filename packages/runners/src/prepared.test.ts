// What the executor prepared, applied to a spec (design; moved here by an earlier change so the
// spawn pipeline and the conformance suite share it): /mcp and the network as its programs see them.
import { describe, expect, test } from "vitest";
import type { SpawnSpec } from "./adapter.js";
import { applyPrepared } from "./prepared.js";

const SPEC: SpawnSpec = {
  sessionId: "S1",
  cwd: "/frm/s/S1/repo",
  homeDir: "/frm/s/S1/.frm/home",
  env: { PATH: "/usr/bin", HOME: "/frm/s/S1/.frm/home" },
  model: "m",
  flags: {},
  mcp: { url: "http://127.0.0.1:3010/mcp", token: "t0k3n", tools: ["a"] },
};

describe("applyPrepared", () => {
  test("/mcp through the gateway, and the egress proxy in the env with the gateway exempt", () => {
    const gateway = "frm-ctr-lab-gateway";
    const placed = applyPrepared(SPEC, {
      root: "/frm/s/S1",
      mcpUrl: `http://${gateway}:3010/mcp`,
      proxyUrl: `http://${gateway}:8888`,
    });
    expect(placed.mcp).toEqual({
      ...SPEC.mcp,
      url: `http://${gateway}:3010/mcp`,
    });
    const proxy = `http://${gateway}:8888`;
    const exempt = `localhost,127.0.0.1,${gateway}`;
    expect(placed.env).toEqual({
      ...SPEC.env,
      HTTPS_PROXY: proxy,
      HTTP_PROXY: proxy,
      https_proxy: proxy,
      http_proxy: proxy,
      NO_PROXY: exempt,
      no_proxy: exempt,
    });
  });

  test("an executor that prepares neither leaves the spec as it is; no mount stays none", () => {
    expect(applyPrepared(SPEC, { root: "/x" })).toEqual(SPEC);
    const bare: SpawnSpec = {
      sessionId: "S2",
      cwd: "/w",
      homeDir: "/h",
      env: {},
      model: "m",
      flags: {},
    };
    expect(
      applyPrepared(bare, { root: "/x", mcpUrl: "http://g:3010/mcp" }).mcp,
    ).toBeUndefined();
  });
});
