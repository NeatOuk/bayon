import { ExecutorHealthDetail } from "@bayon/core";
import { describe, expect, test } from "vitest";
import type { ExecutorUsage } from "./container.js";
import {
  gatherFacts,
  healthDetail,
  judgeHealth,
  NO_LEFTOVERS,
  type GatherDeps,
  type HealthFacts,
} from "./health.js";
import { PlumbingScripts } from "./plumbing-scripts.js";
import { layoutOf } from "./route.js";

const GIB = 1024 ** 3;
const LIMITS = { clockSkewMaxMs: 5_000, minFreePct: 10, quotaGb: 15 };
const USAGE: ExecutorUsage = {
  freePct: 20,
  usedBytes: 2 * GIB,
  sessions: [
    { sessionId: "s-small", bytes: GIB },
    { sessionId: "s-big", bytes: 3 * GIB },
  ],
};
const GOOD: HealthFacts = {
  ssh: null,
  clockSkewMs: 40,
  docker: "29.1.3",
  imagePresent: true,
  gateway: null,
  tunnel: "up",
  mcp: "401",
  relay: "404|refused",
  leftovers: NO_LEFTOVERS,
  usage: USAGE,
  usageError: null,
};

describe("judgeHealth", () => {
  test("healthy when every check passes", () => {
    expect(judgeHealth(GOOD, LIMITS)).toEqual({
      failures: [],
      warnings: [],
      reclaim: null,
    });
  });

  test("ssh failing is the only failure reported: nothing else could be measured", () => {
    expect(judgeHealth({ ...GOOD, ssh: "no route to host" }, LIMITS)).toEqual({
      failures: ["ssh: no route to host"],
      warnings: [],
      reclaim: null,
    });
  });

  test.each([
    [{ clockSkewMs: -5_001 }, "clock: skewed -5001 ms (max 5000)"],
    [{ clockSkewMs: 7_000 }, "clock: skewed 7000 ms (max 5000)"],
    [{ clockSkewMs: null }, "clock: the host printed no time"],
    [{ docker: null }, "docker: the daemon does not answer"],
    [{ imagePresent: false }, "image: not on the docker host"],
    [
      { gateway: "network frm-internal is not ours" },
      "gateway: network frm-internal",
    ],
    [{ tunnel: "down" as const }, "tunnel: the /mcp reverse tunnel is down"],
    [
      { mcp: "error:ECONNREFUSED" },
      "mcp: /mcp through the gateway answered error:ECONNREFUSED",
    ],
    [{ mcp: "no-gateway" }, "answered no-gateway, not 401"],
    // A gateway still passing every path (a byte relay, an old image): an earlier change §1.
    [
      { relay: "401|-" },
      "relay: POST /api/v1/executors through the gateway answered 401|-",
    ],
    [{ relay: "no answer" }, "relay: POST /api/v1/executors"],
    [{ usageError: "timeout" }, "disk: timeout"],
  ])("%j fails with %s", (change, failure) => {
    const verdict = judgeHealth({ ...GOOD, ...change }, LIMITS);
    expect(verdict.failures).toEqual([expect.stringContaining(failure)]);
    expect(verdict.reclaim).toBeNull();
  });

  test("no tunnel and no gateway: those checks are not made", () => {
    expect(
      judgeHealth({ ...GOOD, tunnel: null, mcp: null, relay: null }, LIMITS)
        .failures,
    ).toEqual([]);
  });

  test("build leftovers are warnings, never failures; unlabelled ones say they are never touched", () => {
    const verdict = judgeHealth(
      {
        ...GOOD,
        leftovers: {
          labelled: ["ctr:aaaaaaaaaaaa"],
          unlabelled: ["ctr:bbbbbbbbbbbb", "img:111111111111"],
          capped: true,
        },
      },
      LIMITS,
    );
    expect(verdict.failures).toEqual([]);
    expect(verdict.warnings).toEqual([
      expect.stringMatching(
        /^build: 2 object\(s\) .* carry no frm labels .*ctr:bbbbbbbbbbbb, img:111111111111.*never touched here/,
      ),
      expect.stringMatching(
        /^build: 1 labelled leftover\(s\) .*ctr:aaaaaaaaaaaa.*frm executor image/,
      ),
      "build: the dangling-image scan stopped at its cap",
    ]);
    expect(judgeHealth({ ...GOOD, leftovers: null }, LIMITS)).toMatchObject({
      failures: [],
      warnings: ["build: the leftover scan did not answer"],
    });
  });

  test("over the quota or under min_free_pct: unhealthy, and the largest session is reclaimed", () => {
    const over = judgeHealth(
      { ...GOOD, usage: { ...USAGE, usedBytes: 16 * GIB } },
      LIMITS,
    );
    expect(over).toEqual({
      failures: ["disk: 16 GiB used, over quota_gb 15"],
      warnings: [],
      reclaim: "s-big",
    });
    const low = judgeHealth(
      { ...GOOD, usage: { ...USAGE, freePct: 9.44 } },
      LIMITS,
    );
    expect(low).toEqual({
      failures: ["disk: 9.4 % free, under min_free_pct 10"],
      warnings: [],
      reclaim: "s-big",
    });
  });

  test("nothing of ours to reclaim: still unhealthy", () => {
    const verdict = judgeHealth(
      {
        ...GOOD,
        usage: {
          freePct: 5,
          usedBytes: 0,
          sessions: [{ sessionId: "s", bytes: 0 }],
        },
      },
      LIMITS,
    );
    expect(verdict.reclaim).toBeNull();
    expect(verdict.failures).toHaveLength(1);
  });
});

describe("gatherFacts", () => {
  const scripts = new PlumbingScripts(
    "ctr-lab",
    layoutOf("/home/ops/frm"),
    "frm-internal",
  );
  // The host's clock, in nanoseconds: 1_700_000_000_350 ms.
  const HOST_NS = "1700000000350000000";
  const deps = (over: Partial<GatherDeps> = {}): GatherDeps => {
    let now = 1_700_000_000_000;
    return {
      scripts,
      run: async (command) =>
        command === scripts.clock()
          ? { code: 0, stdout: `${HOST_NS}\n`, stderr: "" }
          : {
              code: 0,
              stdout: "docker 29.1.3\nimage 1\nmcp 401\nrelay 404|refused\n",
              stderr: "",
            },
      usage: async () => USAGE,
      leftovers: async () => NO_LEFTOVERS,
      image: "frm-ctr-lab:0123456789ab",
      ensureGateway: async () => undefined,
      tunnel: () => "up",
      mcp: { port: 3010, path: "/mcp" },
      now: () => (now += 100),
      ...over,
    };
  };

  test("measures the skew against the round trip's midpoint and reads the tagged probe", async () => {
    // t0 = …100 and t1 = …200 ms: the midpoint is …150; the host said …350.
    expect(await gatherFacts(deps())).toEqual({ ...GOOD, clockSkewMs: 200 });
  });

  test("a failing first round trip is an ssh failure; the rest is not attempted", async () => {
    let calls = 0;
    const facts = await gatherFacts(
      deps({
        run: async () => {
          calls += 1;
          throw new Error("ssh to 192.0.2.10 failed: no answer");
        },
      }),
    );
    expect(facts.ssh).toBe("ssh to 192.0.2.10 failed: no answer");
    expect(calls).toBe(1);
  });

  test("every other failure is recorded, not thrown", async () => {
    const facts = await gatherFacts(
      deps({
        ensureGateway: async () => {
          throw new Error("frm-internal is not ours");
        },
        run: async (command) =>
          command === scripts.clock()
            ? { code: 0, stdout: "garbage", stderr: "" }
            : {
                code: 0,
                stdout:
                  "docker -\nimage 0\nmcp error:ECONNREFUSED\nrelay error:ECONNREFUSED\n",
                stderr: "",
              },
        usage: async () => {
          throw new Error("disk guard timed out");
        },
        leftovers: async () => {
          throw new Error("scan timed out");
        },
        tunnel: () => "down",
      }),
    );
    expect(facts).toMatchObject({
      ssh: null,
      clockSkewMs: null,
      docker: null,
      imagePresent: false,
      gateway: "frm-internal is not ours",
      tunnel: "down",
      mcp: "error:ECONNREFUSED",
      relay: "error:ECONNREFUSED",
      leftovers: null,
      usage: null,
      usageError: "disk guard timed out",
    });
  });

  test("the scan's leftovers reach the facts as the executor reports them", async () => {
    const found = {
      labelled: [],
      unlabelled: [`ctr:${"b".repeat(12)}`],
      capped: false,
    };
    expect(
      (await gatherFacts(deps({ leftovers: async () => found }))).leftovers,
    ).toEqual(found);
  });

  test("without a tunnel, /mcp is neither probed nor judged", async () => {
    const seen: string[] = [];
    const facts = await gatherFacts(
      deps({
        tunnel: null,
        ensureGateway: null,
        run: async (command) => {
          seen.push(command);
          return command === scripts.clock()
            ? { code: 0, stdout: HOST_NS, stderr: "" }
            : { code: 0, stdout: "docker 29.1.3\nimage 1\n", stderr: "" };
        },
      }),
    );
    expect(facts).toMatchObject({
      tunnel: null,
      mcp: null,
      relay: null,
      gateway: null,
    });
    expect(seen.join("\n")).not.toContain("mcp");
  });
});

test("clock skew at the max passes: the spec says at most", () => {
  expect(judgeHealth({ ...GOOD, clockSkewMs: 5_000 }, LIMITS).failures).toEqual(
    [],
  );
});

test("the detail is the uniform one, disk measured under remote_root", () => {
  const verdict = judgeHealth(GOOD, LIMITS);
  const detail = healthDetail(GOOD, verdict, {
    checkedAt: 7,
    rttMs: 1,
    image: "img",
    root: "/srv/frm",
    limits: LIMITS,
    reclaimed: null,
  });
  expect(ExecutorHealthDetail.parse(detail)).toMatchObject({
    free_pct: 20,
    min_free_pct: 10,
    disk: [{ path: "/srv/frm", free_pct: 20, error: null }],
    clock_skew_max_ms: 5_000,
  });
  const unmeasured = { ...GOOD, usage: null, usageError: "df: timeout" };
  expect(
    healthDetail(unmeasured, judgeHealth(unmeasured, LIMITS), {
      checkedAt: 7,
      rttMs: 1,
      image: "img",
      root: "/srv/frm",
      limits: LIMITS,
      reclaimed: null,
    }),
  ).toMatchObject({
    free_pct: null,
    disk: [{ path: "/srv/frm", free_pct: null, error: "df: timeout" }],
  });
});

test("the detail carries the round trip, the measurements and the failures", () => {
  const verdict = judgeHealth({ ...GOOD, tunnel: "down" }, LIMITS);
  expect(
    healthDetail({ ...GOOD, tunnel: "down" }, verdict, {
      checkedAt: 7,
      rttMs: 312,
      image: "frm-ctr-lab:0123456789ab",
      root: "/srv/frm",
      limits: LIMITS,
      reclaimed: null,
    }),
  ).toEqual({
    checked_at: 7,
    rtt_ms: 312,
    clock_skew_ms: 40,
    clock_skew_max_ms: 5_000,
    disk: [{ path: "/srv/frm", free_pct: 20, error: null }],
    docker: "29.1.3",
    image: "frm-ctr-lab:0123456789ab",
    image_present: true,
    tunnel: "down",
    mcp: "401",
    relay: "404|refused",
    build_leftovers: { labelled: [], unlabelled: [], capped: false },
    free_pct: 20,
    used_gb: 2,
    min_free_pct: 10,
    quota_gb: 15,
    reclaimed: null,
    failures: ["tunnel: the /mcp reverse tunnel is down"],
    warnings: [],
  });
});
