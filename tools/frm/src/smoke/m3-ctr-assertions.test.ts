import type {
  EventItem,
  ExecutorView,
  RunnerConformanceResult,
} from "@bayon/proto";
import { describe, expect, test } from "vitest";
import {
  absentProblems,
  cleanProblems,
  conformance11Problems,
  digestOf,
  egressProblems,
  healthProblems,
  inspectProblems,
  mcpRoundTripProblems,
  noFilesProblems,
  reachedProblems,
  refProblems,
} from "./m3-ctr-assertions.js";

test("refProblems: a ctr: ref on this run's executor", () => {
  expect(
    refProblems("ctr:ctr-lab-ab12cd:0123456789ab:tok", "ctr-lab-ab12cd"),
  ).toEqual([]);
  expect(refProblems("local:123:456", "ctr-lab-ab12cd")).toEqual([
    "executor_ref local:123:456 does not start with ctr:ctr-lab-ab12cd:",
  ]);
  expect(refProblems(null, "x")).toHaveLength(1);
  expect(refProblems("ctr:ctr-lab-ab12cdX:1:2", "ctr-lab-ab12cd")).toHaveLength(
    1,
  );
});

describe("healthProblems", () => {
  const view = (health: string, detail: unknown): ExecutorView => ({
    id: "c",
    kind: "container",
    trust: "untrusted",
    egress_policy: "allowlist",
    slots: 2,
    enabled: true,
    health,
    health_checked_at: 1,
    health_detail: detail as ExecutorView["health_detail"],
    config: null,
  });
  test("healthy with its tunnel up and /mcp 401 through the gateway", () => {
    expect(
      healthProblems(
        view("healthy", { tunnel: "up", mcp: "401", failures: [] }),
      ),
    ).toEqual([]);
  });
  test("each missing fact is named", () => {
    expect(healthProblems(undefined)).toEqual([
      "GET /executors does not list the executor",
    ]);
    expect(
      healthProblems(
        view("unhealthy", {
          tunnel: "down",
          mcp: "no answer",
          failures: ["tunnel: down"],
        }),
      ),
    ).toEqual([
      "the executor is unhealthy: tunnel: down",
      "the /mcp tunnel is down",
      "/mcp through the gateway answered no answer, not 401",
    ]);
  });
});

test("mcpRoundTripProblems: the tool's call came back ok", () => {
  const call = (status: string): EventItem =>
    ({
      id: 1,
      kind: "mcp_call",
      tool_name: "ticket_get",
      status,
      payload: {},
    }) as unknown as EventItem;
  expect(mcpRoundTripProblems([call("ok")], "ticket_get")).toEqual([]);
  expect(mcpRoundTripProblems([call("error")], "ticket_get")).toEqual([
    "ticket_get's mcp_call did not come back: error",
  ]);
  expect(mcpRoundTripProblems([], "ticket_get")).toEqual([
    "no ticket_get mcp_call in the session",
  ]);
});

describe("the canary", () => {
  const canary = "frm-canary-00112233445566778899aabb";
  const inspect = (env: string[]) =>
    JSON.stringify([
      { Id: "aaaa1111bbbb2222", Config: { Env: env } },
      { Id: "cccc3333", Config: { Env: [] } },
    ]);
  test("inspect covers the session's container and holds no canary", () => {
    expect(
      inspectProblems(inspect(["PATH=/bin"]), canary, ["aaaa1111bbbb"]),
    ).toEqual([]);
    expect(
      inspectProblems(inspect([`KEY=${canary}`]), canary, ["aaaa1111bbbb"]),
    ).toEqual(["the canary is in docker inspect"]);
    expect(inspectProblems(inspect([]), canary, ["dddd"])).toEqual([
      "docker inspect did not cover dddd",
    ]);
    expect(inspectProblems("[]", canary, [])).toEqual([
      "docker inspect listed no container",
    ]);
    expect(inspectProblems("not json", canary, [])).toEqual([
      "docker inspect did not print JSON",
    ]);
  });
  test("files, logs and the positive control", () => {
    expect(noFilesProblems("the disk", [])).toEqual([]);
    expect(noFilesProblems("the disk", ["/r/a"])).toEqual([
      "the canary is on the disk: /r/a",
    ]);
    expect(absentProblems("the raw log", "x", canary)).toEqual([]);
    expect(absentProblems("the raw log", `x${canary}y`, canary)).toEqual([
      "the canary is in the raw log",
    ]);
    expect(reachedProblems(["/r/env-0.json"])).toEqual([]);
    expect(reachedProblems([])).toHaveLength(1);
    expect(digestOf("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

test("egressProblems: 200 through the gateway, 403 for another host, no direct route", () => {
  const hosts = { allowed: "example.com", refused: "example.org" };
  expect(
    egressProblems(
      {
        allowed: "CONNECT example.com 200",
        refused: "CONNECT example.org 403",
        direct: "DIRECT error ENETUNREACH",
      },
      hosts,
    ),
  ).toEqual([]);
  expect(
    egressProblems(
      {
        allowed: "CONNECT example.com timeout",
        refused: "CONNECT example.org 200",
        direct: "DIRECT connected",
      },
      hosts,
    ),
  ).toEqual([
    "the allowed host: CONNECT example.com timeout",
    "the disallowed host: CONNECT example.org 200, not a 403",
    "a direct connection: DIRECT connected, not refused",
  ]);
});

test("cleanProblems: nothing labelled left, the root gone, every unlabelled container still there", () => {
  const clean = {
    containers: "0",
    networks: "0",
    images: "0",
    volumes: "0",
    root: "gone",
  };
  expect(cleanProblems(clean, ["a", "b"], ["a", "b", "c"])).toEqual([]);
  expect(
    cleanProblems(
      { ...clean, containers: "2", root: "left" },
      ["a", "b"],
      ["a"],
    ),
  ).toEqual([
    "2 labelled containers left",
    "the remote root is left",
    "1 unlabelled container(s) went missing",
  ]);
});

describe("conformance11Problems", () => {
  const summary: RunnerConformanceResult["summary"] = {
    passed: [1, 2, 11],
    failed: [],
    na: [3],
    incomplete: [],
    unverified_caps: [],
    certifiable: true,
    gate_eligible: true,
    unattended_allowed: true,
  };
  const r: RunnerConformanceResult = {
    runner_id: "r",
    executor_id: "ctr-1",
    model_id: "r.cheap",
    model: "r-cheap",
    runner_version: "v",
    report_path: "/p",
    stored: true,
    passed_at: 1,
    summary,
    teardown: [],
    compression: false,
  };
  test("test 11 passed on the container, and the pair is certified", () => {
    expect(conformance11Problems(r, "ctr-1")).toEqual([]);
  });
  test("test 11 incomplete and nothing stored: both named", () => {
    expect(
      conformance11Problems(
        {
          ...r,
          stored: false,
          summary: {
            ...summary,
            passed: [1],
            incomplete: [5, 11],
            gate_eligible: false,
            certifiable: false,
          },
        },
        "ctr-1",
      ),
    ).toEqual([
      "test 11 (MCP round-trip) did not pass on ctr-1: incomplete",
      "the pair is not certified gate-eligible (incomplete: 5, 11; failed: none)",
    ]);
    expect(conformance11Problems(r, "ctr-2")[0]).toBe(
      "the suite ran on ctr-1, not ctr-2",
    );
  });
});
