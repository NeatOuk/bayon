import { describe, expect, test } from "vitest";
import {
  ApiErrorBody,
  BudgetSettings,
  CommandView,
  EVENTS_PAGE_DEFAULT_LIMIT,
  EVENTS_PAGE_MAX_LIMIT,
  EventsPage,
  EventsQuery,
  Fleet,
  FleetRow,
  SessionView,
} from "./rest.js";

const fleetRow = {
  id: "S1",
  agent: "builder",
  role: "build",
  run_class: "build",
  state: "running",
  runner_id: "fixture",
  executor_id: "local",
  model_tier: null,
  ticket: null,
  title: null,
  turns: 3,
  cost_usd: 0.12,
  idle_ms: 5_000,
  workspace_id: "ws-shop",
  ticket_key: null,
};

const session = {
  id: "S1",
  agent_id: "A1",
  agent_name: "builder",
  ticket_id: null,
  role: "build",
  run_class: "build",
  runner_id: "fixture",
  runner_version: null,
  runner_session_id: null,
  executor_id: "local",
  executor_ref: null,
  model: null,
  model_tier: null,
  effort: null,
  workspace_id: null,
  session_root: "/frm/runtime/sessions/S1",
  home_dir: "/frm/runtime/sessions/S1/home",
  config_hash: "abc",
  mission_hash: null,
  doctrine_hash: null,
  toolset_hash: null,
  state: "idle",
  predecessor_session_id: null,
  handoff_in_id: null,
  handoff_out_id: null,
  raw_log_path: "/frm/runtime/sessions/S1/logs/stdout.jsonl",
  pty_log_path: null,
  tmux_target: null,
  attach_lease_owner: null,
  attach_lease_expires_at: null,
  attach_intent_owner: null,
  attach_intent_at: null,
  turns: 1,
  tool_calls: 0,
  cost_usd: 0,
  cost_source: "reported",
  tokens_in: 0,
  tokens_out: 0,
  tokens_cache_read: 0,
  tokens_cache_write: 0,
  context_peak_tokens: null,
  context_ruleset: null,
  tokens_saved: null,
  context: null,
  last_event_at: 10,
  started_at: 5,
  ended_at: null,
  exit_reason: null,
  error_class: null,
  error_message: null,
  created_at: 1,
  raw_segment_offset: 0,
};

const overview = {
  paused: false,
  budget: { today_usd: 1.5, daily_cap_usd: null },
  budgets: [],
  slots: [{ executor_id: "local", busy: 1, capacity: 4 }],
  attention: [
    {
      session_id: "S1",
      agent: "builder",
      why: "stale",
      since: 10,
      detail: null,
    },
  ],
  disk: [
    { executor_id: "local", free_pct: 41.5, min_free_pct: 10, checked_at: 9 },
    {
      executor_id: "ctr-1",
      free_pct: null,
      min_free_pct: null,
      checked_at: null,
    },
  ],
  admission: {
    queued: [
      {
        session_id: "S2",
        agent: "builder",
        executor_id: "local",
        reason: "slot",
        since: 11,
      },
    ],
    by_reason: { slot: 1 },
  },
  backup: {
    last: {
      outcome: "failed",
      started_at: 20,
      ended_at: 21,
      path: null,
      error: "secret FRM_BACKUP_KEY is not in the secret store",
    },
    last_ok_at: 12,
  },
  runner_updates: [
    {
      runner_id: "runner-a",
      current: "0.3.283",
      latest: "0.3.290",
      notes_url: "https://example.com/changelog",
      found_at: 30,
    },
  ],
};

describe("fleet", () => {
  test("a fleet row mirrors v_fleet, with NULL columns as null", () => {
    expect(FleetRow.parse(fleetRow)).toEqual(fleetRow);
    expect(FleetRow.safeParse({ ...fleetRow, state: "sleeping" }).success).toBe(
      false,
    );
  });

  test("a fleet carries its sessions, budget, slots, attention and admission", () => {
    const fleet = { sessions: [fleetRow], ...overview };
    expect(Fleet.parse(fleet)).toEqual(fleet);
    const capped = { ...fleet, budget: { today_usd: 0, daily_cap_usd: 40 } };
    expect(Fleet.parse(capped).budget.daily_cap_usd).toBe(40);
  });

  test.each([
    ["no budget", { sessions: [], slots: [], attention: [] }],
    [
      "a negative cap",
      {
        sessions: [],
        ...overview,
        budget: { today_usd: 0, daily_cap_usd: -1 },
      },
    ],
    [
      "an unknown reason",
      {
        sessions: [],
        ...overview,
        attention: [{ ...overview.attention[0], why: "bored" }],
      },
    ],
    ["no disk", { sessions: [], ...overview, disk: undefined }],
    ["no backup block", { sessions: [], ...overview, backup: undefined }],
    [
      "a backup outcome that is neither ok nor failed",
      {
        sessions: [],
        ...overview,
        backup: {
          last: { ...overview.backup.last, outcome: "partial" },
          last_ok_at: null,
        },
      },
    ],
    [
      "a free % over 100",
      {
        sessions: [],
        ...overview,
        disk: [{ ...overview.disk[0], free_pct: 120 }],
      },
    ],
    [
      "a queued reason that is no queue gate",
      {
        sessions: [],
        ...overview,
        admission: {
          queued: [{ ...overview.admission.queued[0], reason: "trust" }],
          by_reason: {},
        },
      },
    ],
  ])("refuses %s", (_name, value) => {
    expect(Fleet.safeParse(value).success).toBe(false);
  });
});

describe("budget settings", () => {
  test("a cap or null, both non-negative", () => {
    expect(BudgetSettings.parse({ daily_cap_usd: 40 })).toEqual({
      daily_cap_usd: 40,
    });
    expect(BudgetSettings.parse({ daily_cap_usd: null })).toEqual({
      daily_cap_usd: null,
    });
  });

  test.each([
    ["a negative cap", { daily_cap_usd: -1 }],
    ["NaN", { daily_cap_usd: Number.NaN }],
    ["a string", { daily_cap_usd: "40" }],
    ["a missing field", {}],
  ])("refuses %s", (_name, value) => {
    expect(BudgetSettings.safeParse(value).success).toBe(false);
  });
});

describe("session", () => {
  test("the session view never carries the MCP token hash", () => {
    const parsed = SessionView.parse({ ...session, mcp_token_hash: "secret" });
    expect(parsed).toEqual(session);
    expect("mcp_token_hash" in parsed).toBe(false);
  });

  test("state, exit reason and error class are the closed core enums", () => {
    for (const bad of [
      { state: "napping" },
      { exit_reason: "bored" },
      { error_class: "oops" },
    ]) {
      expect(SessionView.safeParse({ ...session, ...bad }).success).toBe(false);
    }
  });
});

describe("events query", () => {
  test("since and limit arrive as strings and default sensibly", () => {
    expect(EventsQuery.parse({})).toEqual({
      since: 0,
      limit: EVENTS_PAGE_DEFAULT_LIMIT,
    });
    expect(EventsQuery.parse({ since: "12", limit: "50" })).toEqual({
      since: 12,
      limit: 50,
    });
  });

  test("kind is a comma list or repeated, and must be canonical", () => {
    expect(EventsQuery.parse({ kind: "tool_call,error" }).kind).toEqual([
      "tool_call",
      "error",
    ]);
    expect(EventsQuery.parse({ kind: ["tool_call", "terminal"] }).kind).toEqual(
      ["tool_call", "terminal"],
    );
    expect(EventsQuery.safeParse({ kind: "tool_call,nope" }).success).toBe(
      false,
    );
  });

  test("out-of-range values are rejected", () => {
    for (const query of [
      { since: "-1" },
      { since: "1.5" },
      { since: "abc" },
      { limit: "0" },
      { limit: String(EVENTS_PAGE_MAX_LIMIT + 1) },
    ]) {
      expect(EventsQuery.safeParse(query).success).toBe(false);
    }
  });
});

describe("events page", () => {
  test("carries items, the next cursor and whether more remain", () => {
    const page = {
      items: [
        {
          id: 4,
          kind: "tool_result",
          ts: 1,
          runner_type: "user",
          status: "ok",
          payload: { call_id: "c1", output_path: "/tmp/out.txt" },
          truncated: true,
          bytes_original: 90_000,
        },
      ],
      next_cursor: 4,
      has_more: false,
    };
    expect(EventsPage.parse(page)).toEqual(page);
  });
});

describe("command view and error body", () => {
  test("a command view exposes state, result and error", () => {
    const view = {
      id: "C1",
      ts: 1,
      type: "session.spawn",
      payload: { session_id: "S1" },
      state: "failed",
      idempotency_key: null,
      claimed_at: 2,
      attempts: 1,
      result: null,
      error: { class: "spawn_failed", message: "boom", retryable: false },
      now: 9,
      ahead: [],
    };
    expect(CommandView.parse(view)).toEqual(view);
    expect(CommandView.safeParse({ ...view, state: "lost" }).success).toBe(
      false,
    );
  });

  test("a command view carries the server's clock and the queue ahead of it", () => {
    const view = {
      id: "C2",
      ts: 10,
      type: "runner.conformance",
      payload: { runner_id: "runner-a", executor_id: "local" },
      state: "claimed",
      idempotency_key: null,
      claimed_at: 11,
      attempts: 1,
      result: null,
      error: null,
      now: 400,
      ahead: [
        {
          id: "C1",
          ts: 5,
          state: "claimed",
          claimed_at: 6,
          payload: { runner_id: "runner-a", executor_id: "ctr-1" },
        },
      ],
    };
    expect(CommandView.parse(view)).toEqual(view);
    // Only an unsettled command can be queued ahead of another.
    const settled = { ...view.ahead[0], state: "done" };
    expect(CommandView.safeParse({ ...view, ahead: [settled] }).success).toBe(
      false,
    );
    // Each is required on its own: without either, a reader cannot say what is going on.
    for (const dropped of ["now", "ahead"]) {
      const without = Object.fromEntries(
        Object.entries(view).filter(([key]) => key !== dropped),
      );
      expect(CommandView.safeParse(without).success).toBe(false);
    }
  });

  test("errors travel as { error: FrmError } without a cause", () => {
    const body = {
      error: { class: "not_found", message: "no session", retryable: false },
    };
    expect(ApiErrorBody.parse(body)).toEqual(body);
    expect(
      ApiErrorBody.parse({ error: { ...body.error, cause: "stack" } }),
    ).toEqual(body);
  });
});
