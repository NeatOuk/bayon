import {
  DEFAULT_RUN_CLASSES,
  FakeClock,
  loadRunClasses,
  type RunClass,
} from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf } from "./connection.js";
import { listRunClasses } from "./repos/fleet.js";
import { tempDb, unwrap } from "./testing.js";

const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
afterAll(() => t.cleanup());
const { raw } = unwrap(internalsOf(t.db));
const byName = (a: RunClass, b: RunClass) => a.name.localeCompare(b.name);

test("the seeded run_classes equal core's DEFAULT_RUN_CLASSES, row for row", async () => {
  const rows = unwrap(await listRunClasses(t.db));
  expect(rows).toEqual(DEFAULT_RUN_CLASSES.toSorted(byName));
});

test("core's loadRunClasses accepts the seeded rows", async () => {
  const loaded = await loadRunClasses(async () => {
    const rows = await listRunClasses(t.db);
    if (!rows.ok) throw rows.error;
    return rows.value;
  });
  expect(unwrap(loaded).size).toBe(DEFAULT_RUN_CLASSES.length);
});

test("settings hold the eight §4 keys, the daily budget cap, 004's eight M2 keys, 007's four M3 keys, 008's retry budget, 011's poll, 012's fifteen M4 keys, 013's requeue attempts, 015's five sweep keys, 016's agent git identity, 020's parity switch, 024's lint switch, 026's login consent, 033's Jira timer, the notifier's fourteen keys, 042's quick Jira pass, 043's CI grace and 051's update check", () => {
  const rows = raw
    .prepare("SELECT key, value_json FROM settings ORDER BY key")
    .all();
  expect(rows).toEqual([
    { key: "admission.disk_min_free_pct", value_json: "10" },
    { key: "admission.recheck_ms", value_json: "5000" },
    { key: "admission.require_certified", value_json: "1" },
    {
      key: "agents.git_author",
      value_json: '"Bayon Agent <agent@bayon.invalid>"',
    },
    { key: "autosplit.enabled", value_json: "1" },
    { key: "autosplit.handoff_threshold", value_json: "4" },
    { key: "autosplit.max_children", value_json: "5" },
    { key: "autosplit.max_depth", value_json: "2" },
    { key: "backup.at_utc_hour", value_json: "3" },
    { key: "backup.enabled", value_json: "1" },
    { key: "backup.keep", value_json: "14" },
    { key: "budget.daily_cap_usd", value_json: "null" },
    { key: "executor.clock_skew_max_ms", value_json: "5000" },
    { key: "executors.untrusted_roles", value_json: '["investigator"]' },
    { key: "fleet.paused", value_json: "0" },
    { key: "gates.base_drift", value_json: '"fail"' },
    { key: "gates.blocking_severities", value_json: '["blocker","major"]' },
    // 052: how many drifted review rounds running before the operator decides.
    { key: "gates.drift_rounds_max", value_json: "3" },
    { key: "gates.lint_check", value_json: "false" },
    { key: "gates.parity_check", value_json: "false" },
    { key: "gates.supersede_poll_ms", value_json: "5000" },
    { key: "gates.timeout_retries", value_json: "1" },
    { key: "gates.wall_clock_ms", value_json: "900000" },
    { key: "handoff.max_turns", value_json: "3" },
    { key: "handoff.packet_tokens_cap", value_json: "1200" },
    { key: "handoff.prompt_tokens_cap", value_json: "1500" },
    { key: "handoff.wall_clock_ms", value_json: "300000" },
    // 033: the Jira mirror's timer, every 15 minutes.
    // 042: its quick pass, every minute.
    { key: "jira.quick_interval_ms", value_json: "60000" },
    { key: "jira.sync_interval_ms", value_json: "900000" },
    // The notifications migration: every channel off, each subscribed to every event
    // kind, quiet hours off, and the three shell-only strings empty (unset).
    { key: "notify.base_url", value_json: '""' },
    { key: "notify.email.enabled", value_json: "0" },
    { key: "notify.email.events", value_json: "127" },
    { key: "notify.email.from", value_json: '""' },
    { key: "notify.email.to", value_json: '""' },
    { key: "notify.mac.enabled", value_json: "0" },
    { key: "notify.mac.events", value_json: "127" },
    { key: "notify.ntfy.enabled", value_json: "0" },
    { key: "notify.ntfy.events", value_json: "127" },
    { key: "notify.poll_ms", value_json: "15000" },
    { key: "notify.quiet_end_hour", value_json: "-1" },
    { key: "notify.quiet_start_hour", value_json: "-1" },
    { key: "notify.webhook.enabled", value_json: "0" },
    { key: "notify.webhook.events", value_json: "127" },
    { key: "preflight.margin_pct", value_json: "15" },
    // 027: no folder a project's repo may be a path inside.
    { key: "projects.local_roots", value_json: "[]" },
    { key: "pulse.lease_ttl_ms", value_json: "1020000" },
    // 043: ten minutes for a CI to report its first check.
    { key: "qa.ci_grace_ms", value_json: "600000" },
    { key: "reconciler.command_max_attempts", value_json: "3" },
    { key: "reconciler.command_requeue_ms", value_json: "300000" },
    { key: "retention.events_days", value_json: "30" },
    { key: "retention.qa_video_days", value_json: "14" },
    { key: "retention.reasoning", value_json: '"keep"' },
    { key: "roles.require_distinct_reviewer", value_json: "1" },
    // 026: consent to a login used in place, granted to nobody.
    { key: "runners.login_in_place", value_json: "{}" },
    // 051: daily by default; 0 turns the check off.
    { key: "runners.update_check_hours", value_json: "24" },
    { key: "spend.alarm_pct", value_json: "25" },
    { key: "spend.baseline_days", value_json: "30" },
    { key: "watchdog.circuit_failed_runs", value_json: "3" },
    { key: "watchdog.retry_storm_backoff_ms", value_json: "900000" },
    { key: "watchdog.retry_storm_count", value_json: "5" },
    { key: "watchdog.retry_storm_window_ms", value_json: "600000" },
    { key: "watchdog.silent_ms", value_json: "1800000" },
    {
      key: "worktree.disposable_ignored",
      value_json:
        '["node_modules/","dist/","build/","target/",".venv/","__pycache__/",".pytest_cache/",".mypy_cache/",".ruff_cache/",".turbo/",".next/","coverage/"]',
    },
    { key: "worktree.min_ended_ms", value_json: "3600000" },
    { key: "worktree.mirror_tmp_min_age_ms", value_json: "86400000" },
    { key: "worktree.recheck_ms", value_json: "3600000" },
    { key: "worktree.remove_timeout_ms", value_json: "900000" },
    { key: "worktree.request_min_gap_ms", value_json: "60000" },
  ]);
});

test("no runner or model rows are seeded: they come from registration() (Invariant 1)", () => {
  const count = (table: string) =>
    raw.prepare(`SELECT count(*) AS n FROM ${table}`).get();
  expect(count("runners")).toEqual({ n: 0 });
  expect(count("models")).toEqual({ n: 0 });
});
