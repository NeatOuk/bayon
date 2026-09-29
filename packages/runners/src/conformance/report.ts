// The conformance report: deterministic markdown, already in prettier's own
// table layout so a committed report stays lint-clean. No absolute paths, env, token or per-test
// timings. an earlier change writes it to docs/conformance/<reportFileName(result)>.
import {
  UNVERIFIED_CAPS,
  type ConformanceResult,
  type ConformanceStatus,
  type ConformanceTestId,
  type ConformanceTestResult,
  type RunnerCaps,
} from "@bayon/core";

/** The §15 titles. */
const TITLES: Readonly<Record<ConformanceTestId, string>> = {
  1: "version + health",
  2: "spawn + single turn",
  3: "multi-turn",
  4: "tool call capture",
  5: "file change capture",
  6: "usage capture",
  7: "interrupt",
  8: "kill + adopt",
  9: "no-terminal-event",
  10: "unknown event tolerance",
  11: "MCP round-trip",
  12: "permission mapping",
  13: "structured review output",
  14: "home claim",
  15: "concurrent home isolation",
  16: "extra workspace roots",
  17: "context compression",
};

const SHOWN: Readonly<Record<ConformanceStatus, string>> = {
  pass: "pass",
  fail: "FAIL",
  na: "N/A",
  incomplete: "incomplete",
};

const yesNo = (b: boolean): string => (b ? "yes" : "no");
const oneLine = (s: string): string => s.replace(/\s*\n\s*/g, " ");
const cell = (s: string): string => oneLine(s).replaceAll("|", "\\|");

/** A table as prettier lays one out: every column padded to its widest cell, at least 3. */
function table(
  header: readonly string[],
  rows: readonly (readonly string[])[],
): string[] {
  const widths = header.map((h, i) =>
    Math.max(3, h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: readonly string[]) =>
    `| ${widths.map((w, i) => (cells[i] ?? "").padEnd(w)).join(" | ")} |`;
  return [
    line(header),
    line(widths.map((w) => "-".repeat(w))),
    ...rows.map(line),
  ];
}

function notes(t: ConformanceTestResult): string {
  if (t.status === "na") return t.fallback ?? "";
  if (t.status === "pass") return "";
  const failed = t.checks.find((c) => !c.ok);
  if (failed === undefined) return "";
  return failed.detail === null
    ? failed.name
    : `${failed.name}: ${failed.detail}`;
}

function declared(cap: keyof RunnerCaps, on: boolean): string {
  if (!on) return "no";
  return UNVERIFIED_CAPS.includes(cap) ? "declared, unverified" : "yes";
}

function failures(r: ConformanceResult): string[] {
  const bad = r.tests.filter(
    (t) => t.status === "fail" || t.status === "incomplete",
  );
  if (bad.length === 0) return ["None."];
  return bad.flatMap((t) => [
    `### ${t.id} ${TITLES[t.id]} (${SHOWN[t.status]})`,
    "",
    ...t.checks.map(
      (c) =>
        `- ${c.ok ? "ok" : "FAIL"} \`${c.name}\`${c.detail === null ? "" : ` — ${oneLine(c.detail)}`}`,
    ),
    "",
  ]);
}

/** What the pre-flight health check measured of the executor: shown, never certified. */
export interface ExecutorFacts {
  readonly rttMs: number | null;
  readonly image: string | null;
}

function executorLine(r: ConformanceResult, f: ExecutorFacts): string {
  const rtt = f.rttMs === null ? "unmeasured" : `${Math.round(f.rttMs)} ms`;
  return `executor ${r.executor.kind} · rtt ${rtt} · image ${f.image ?? "none"}`;
}

/**
 * Said out loud when a container run could not identify the image it ran inside.
 * That id is the pair's only falsifiable pin on a container, so such a run certifies nothing for
 * unattended work — and the read that produces it answers null on any failure, which is how a run
 * that passed all fourteen tests still lands here.
 */
function pinLines(r: ConformanceResult): string[] {
  if (r.executor.kind !== "container" || r.executor.image_id !== null)
    return [];
  return [
    "> **No image pinned.** The image this ran inside could not be identified, so nothing here",
    "> could ever lapse and unattended work is refused whatever the tests say. Check the docker",
    "> host answers and its image is present, then re-run `frm runner conformance`.",
    "",
  ];
}

/** What the end of a run left undone: shown by the verdict, since it stores nothing. */
function teardownLines(teardown: readonly string[]): string[] {
  if (teardown.length === 0) return [];
  return [
    "## Teardown",
    "",
    "The run did not end cleanly, so it stored no certification, whatever its tests say:",
    "",
    ...teardown.map((t) => `- ${oneLine(t)}`),
    "",
  ];
}

export function renderReport(
  r: ConformanceResult,
  facts?: ExecutorFacts,
  teardown: readonly string[] = [],
): string {
  const s = r.summary;
  const kit = r.kit_hash.replace(/^sha256:/, "").slice(0, 12);
  const caps = Object.entries(r.caps) as [keyof RunnerCaps, boolean][];
  const lines = [
    `# Conformance — ${r.runner_id} ${r.runner_version} · ${r.model ?? "no model"} on ${r.executor.id}`,
    "",
    [
      new Date(r.started_at).toISOString().slice(0, 10),
      `${Math.round((r.finished_at - r.started_at) / 1000)} s`,
      `ports ingest=${r.ports.ingest}, watchdog=${r.ports.watchdog}, mcp=${r.ports.mcp}, workspace=${r.ports.workspace}`,
      `suite ${r.suite_version}`,
      ...(r.compression === null
        ? []
        : [`compression ${r.compression.ruleset}`]),
      `kit ${kit}`,
      `spend $${r.spend.cost_usd.toFixed(4)}`,
    ].join(" · "),
    "",
    ...(facts === undefined ? [] : [executorLine(r, facts), ""]),
    `**certifiable: ${yesNo(s.certifiable)} · gate_eligible: ${yesNo(s.gate_eligible)} · unattended: ${yesNo(s.unattended_allowed)}** — ${s.passed.length} pass · ${s.failed.length} fail · ${s.na.length} N/A · ${s.incomplete.length} incomplete`,
    "",
    ...pinLines(r),
    ...teardownLines(teardown),
    ...table(
      ["#", "Test", "Result", "Notes"],
      r.tests.map((t) => [
        String(t.id),
        TITLES[t.id],
        SHOWN[t.status],
        cell(notes(t)),
      ]),
    ),
    "",
    "## Declared capabilities",
    "",
    ...table(
      ["Capability", "Declared"],
      caps.map(([cap, on]) => [cap, declared(cap, on)]),
    ),
    "",
    "## Failures",
    "",
    ...failures(r),
  ];
  return `${lines.join("\n").trimEnd()}\n`;
}

/**
 * `<runner>-<version>-<model>@<executor>.md`: certification is per (runner, executor, model), and
 * with compression on (spec M12) per ruleset too: `…@<executor>+<ruleset>.md`.
 */
export function reportFileName(r: ConformanceResult): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]+/g, "_");
  const compression =
    r.compression === null ? "" : `+${safe(r.compression.ruleset)}`;
  return `${safe(r.runner_id)}-${safe(r.runner_version)}-${safe(r.model ?? "no-model")}@${safe(r.executor.id)}${compression}.md`;
}
