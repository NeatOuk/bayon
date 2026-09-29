import {
  CONFORMANCE_TEST_IDS,
  CONFORMANCE_TEST_NAMES,
  SUITE_VERSION,
  certify,
  type ConformanceResult,
  type RunnerCaps,
} from "@bayon/core";
import { format } from "prettier";
import { expect, test } from "vitest";
import { renderReport, reportFileName } from "./report.js";

const CAPS: RunnerCaps = {
  structuredEvents: true,
  multiTurnInProcess: true,
  resumable: true,
  concurrentSessions: true,
  costReporting: true,
  tokenCounting: false,
  toolApprovalCallback: false,
  sandboxModes: false,
  mcpClient: true,
  hooks: false,
  pty: true,
  outputSchema: false,
  imageInput: false,
  subagents: false,
};

function result(): ConformanceResult {
  const certified = certify({
    schema: 1,
    suite_version: SUITE_VERSION,
    runner_id: "demo-runner",
    runner_version: "0.3.269 (cli 2.1.269)",
    model: "demo-model/small",
    executor: { id: "local", kind: "local" },
    started_at: Date.UTC(2026, 8, 14, 10, 0, 0),
    finished_at: Date.UTC(2026, 8, 14, 10, 1, 30),
    kit_hash: `sha256:${"ab".repeat(32)}`,
    ports: {
      ingest: "supervisor",
      watchdog: "supervisor",
      mcp: "supervisor",
      workspace: "supervisor",
    },
    caps: CAPS,
    spend: { tokens_in: 1000, tokens_out: 200, cost_usd: 0.1234 },
    tests: CONFORMANCE_TEST_IDS.map((id) => ({
      id,
      name: CONFORMANCE_TEST_NAMES[id],
      status: id === 12 || id === 13 ? "na" : id === 9 ? "fail" : "pass",
      attempts: 1,
      duration_ms: 10,
      fallback:
        id === 12 ? "static deny held" : id === 13 ? "heuristic | parse" : null,
      checks:
        id === 9
          ? [
              { name: "watchdog_verdict", ok: true, detail: null },
              {
                name: "no_runner_terminal",
                ok: false,
                detail: "0 after the stall,\n1 after kill -9",
              },
            ]
          : [{ name: "held", ok: true, detail: null }],
    })),
  });
  if (!certified.ok) throw new Error(certified.error.message);
  return certified.value;
}

test("the report is already in prettier's layout, so a committed one stays lint-clean", async () => {
  const md = renderReport(result());
  expect(await format(md, { parser: "markdown" })).toBe(md);
});

test("the report shows the verdict, each test, the caps and every failed check", () => {
  const md = renderReport(result());
  expect(md.split("\n").slice(0, 5)).toEqual([
    "# Conformance — demo-runner 0.3.269 (cli 2.1.269) · demo-model/small on local",
    "",
    "2026-09-14 · 90 s · ports ingest=supervisor, watchdog=supervisor, mcp=supervisor, workspace=supervisor · suite 2 · kit abababababab · spend $0.1234",
    "",
    "**certifiable: yes · gate_eligible: no · unattended: no** — 13 pass · 1 fail · 2 N/A · 0 incomplete",
  ]);
  expect(md).toContain(
    "| 9   | no-terminal-event         | FAIL   | no_runner_terminal: 0 after the stall, 1 after kill -9 |",
  );
  expect(md).toContain("heuristic \\| parse");
  expect(md).toContain("| pty                  | declared, unverified |");
  expect(md).toContain(
    "- FAIL `no_runner_terminal` — 0 after the stall, 1 after kill -9",
  );
  expect(md).toContain("- ok `watchdog_verdict`");
  expect(md.endsWith("\n")).toBe(true);
});

test("a clean run lists no failures; the file name is per (runner, version, executor)", () => {
  const r = result();
  const clean = {
    ...r,
    tests: r.tests.map((t) =>
      t.id === 9
        ? {
            ...t,
            status: "pass" as const,
            checks: [{ name: "held", ok: true, detail: null }],
          }
        : t,
    ),
  };
  expect(renderReport(clean)).toContain("## Failures\n\nNone.\n");
  // Per (runner, executor, model): another model's report never overwrites this one.
  expect(reportFileName(r)).toBe(
    "demo-runner-0.3.269_cli_2.1.269_-demo-model_small@local.md",
  );
  expect(reportFileName({ ...r, model: "other" })).not.toBe(reportFileName(r));
});

// The image id is the pair's only pin on a container, and the read that produces
// it answers null on any failure — so a run that passed every test can still certify
// nothing for unattended work. The verdict line says `unattended: no`; this says why, where the
// operator is already reading.
test("a container run that pinned no image says so, above the tests", async () => {
  const r = result();
  const unpinned: ConformanceResult = {
    ...r,
    executor: { id: "ctr-lab", kind: "container", image_id: null },
  };
  const md = renderReport(unpinned);
  expect(md).toContain("**No image pinned.**");
  expect(md.indexOf("No image pinned")).toBeLessThan(md.indexOf("| 9   |"));
  expect(await format(md, { parser: "markdown" })).toBe(md);
  expect(
    renderReport({
      ...unpinned,
      executor: { ...unpinned.executor, image_id: `sha256:${"c".repeat(64)}` },
    }),
  ).not.toContain("No image pinned");
  // Only a container has an image to pin: a local run must not read as one that lost it.
  expect(renderReport(r)).not.toContain("No image pinned");
});

test("a compression-on report says so, shows test 17, and has its own file name (spec M12)", async () => {
  const off = result();
  const on: ConformanceResult = {
    ...off,
    compression: { ruleset: "ctx1" },
    tests: [
      ...off.tests,
      {
        id: 17,
        name: CONFORMANCE_TEST_NAMES[17],
        status: "pass",
        attempts: 1,
        duration_ms: 10,
        fallback: null,
        checks: [{ name: "compressed", ok: true, detail: null }],
      },
    ],
  };
  const md = renderReport(on);
  expect(await format(md, { parser: "markdown" })).toBe(md);
  expect(md).toContain(" · compression ctx1 · ");
  expect(md).toMatch(/\| 17 +\| context compression +\| pass/);
  expect(renderReport(off)).not.toContain("compression");
  expect(reportFileName(on)).toBe(
    `${reportFileName(off).slice(0, -3)}+ctx1.md`,
  );
});
