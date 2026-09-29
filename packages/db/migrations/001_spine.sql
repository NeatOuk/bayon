-- 001_spine: the M0 spine. DDL is spec §4 verbatim, cut to these 21 tables, plus v_fleet (§4.1).
-- tickets and missions are here only because sessions/spend and agents reference them: with
-- foreign_keys=ON, SQLite rejects a child insert whose parent table is missing, even for a NULL key.
-- Every other §4 table, the FTS tables and the other views land in 003 or later.
-- Differences from §4: two comments are runner-neutral (Invariant 1), and
-- sessions.raw_segment_offset is new (spec amendment).

-- ─── registries: runners, executors, models ──────────────────────────────────
CREATE TABLE runners (
  id TEXT PRIMARY KEY,                      -- adapter-defined id, from registration()
  kind TEXT NOT NULL,                       -- 'llm_cli'|'llm_sdk'|'llm_http'|'script'
  adapter TEXT NOT NULL,                    -- module id implementing RunnerAdapter
  version_detected TEXT,                    -- from `<cli> --version` / package version
  caps_json TEXT NOT NULL,                  -- capability matrix, §5.1
  defaults_json TEXT NOT NULL DEFAULT '{}', -- default flags/env for this runner
  conformance_version TEXT,                  -- version last certified
  conformance_passed_at INTEGER,
  conformance_report_path TEXT,
  gate_eligible INTEGER NOT NULL DEFAULT 0, -- may produce gate evidence (needs structured events)
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE executors (
  id TEXT PRIMARY KEY,                      -- 'local','ctr-podman','lxc-prox-01','ssh-build-01'
  kind TEXT NOT NULL CHECK (kind IN ('local','container','remote')),
  config_json TEXT NOT NULL,                -- runtime, image defaults, ssh target, cgroup limits
  slots INTEGER NOT NULL DEFAULT 4,         -- concurrency capacity
  egress_policy TEXT NOT NULL DEFAULT 'allowlist',  -- 'none'|'allowlist'|'open'
  trust TEXT NOT NULL DEFAULT 'untrusted',  -- 'trusted'|'untrusted'  (see §14)
  health TEXT NOT NULL DEFAULT 'unknown',
  health_checked_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE models (                       -- never hardcode a model id in code
  id TEXT PRIMARY KEY,
  runner_id TEXT NOT NULL REFERENCES runners(id),
  tier TEXT NOT NULL,                       -- 'complex'|'standard'|'cheap'
  model TEXT NOT NULL,
  effort TEXT,                              -- reasoning effort / thinking level, if supported
  price_in_per_mtok REAL, price_out_per_mtok REAL,
  price_cache_read_per_mtok REAL, price_cache_write_per_mtok REAL,
  context_tokens INTEGER,
  active INTEGER NOT NULL DEFAULT 1,
  retired_at INTEGER
);
CREATE UNIQUE INDEX models_tier_idx ON models(runner_id, tier) WHERE active = 1;

-- ─── workspaces and repos ────────────────────────────────────────────────────
CREATE TABLE repos (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  origin_url TEXT, mirror_path TEXT NOT NULL,      -- local bare/reference clone
  default_base_branch TEXT NOT NULL DEFAULT 'main',
  image TEXT,                                       -- container image for container executors
  test_cmd TEXT, lint_cmd TEXT, build_cmd TEXT, install_cmd TEXT,
  doctrine_paths_json TEXT NOT NULL DEFAULT '[]',   -- repo doctrine files to hash
  has_submodules INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('single','multi','submodule')),
  default_executor_id TEXT REFERENCES executors(id),
  default_runner_id TEXT REFERENCES runners(id)
);

CREATE TABLE workspace_repos (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  rel_path TEXT NOT NULL,                  -- path under the session root
  role TEXT NOT NULL DEFAULT 'dep',        -- 'primary'|'dep'
  submodule_path TEXT,
  PRIMARY KEY (workspace_id, repo_id)
);

CREATE TABLE worktrees (
  id TEXT PRIMARY KEY,
  session_root TEXT NOT NULL,              -- runtime/work/<ticket>-<short>/
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  path TEXT NOT NULL UNIQUE, branch TEXT NOT NULL,
  base_sha TEXT NOT NULL, head_sha TEXT,
  submodule_shas_json TEXT,
  ticket_id TEXT, session_id TEXT,
  state TEXT NOT NULL,                     -- active|idle|dirty|merged|orphan|removed
  created_at INTEGER NOT NULL, last_used_at INTEGER
);

-- ─── agents, missions, profiles ──────────────────────────────────────────────
CREATE TABLE agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('orchestrator','builder','reviewer','investigator','qa','util')),
  runner_id TEXT NOT NULL REFERENCES runners(id),
  executor_id TEXT REFERENCES executors(id),
  profile_id TEXT REFERENCES profiles(id),
  mission_id TEXT REFERENCES missions(id),
  workspace_id TEXT REFERENCES workspaces(id),
  session_strategy TEXT NOT NULL DEFAULT 'fresh_per_unit',
                                           -- 'fresh_per_unit'|'persistent'|'hybrid'  (§9.3)
  -- pulse scheduling, per agent (§9.7)
  pulse_mode TEXT NOT NULL DEFAULT 'hybrid'
    CHECK (pulse_mode IN ('interval','on_idle','hybrid','manual')),
  pulse_interval_ms INTEGER NOT NULL DEFAULT 5400000,   -- 90 min; the heartbeat / ceiling
  pulse_debounce_ms INTEGER NOT NULL DEFAULT 60000,     -- coalesce a burst of completions
  pulse_min_gap_ms INTEGER NOT NULL DEFAULT 300000,     -- floor: never pulse more often than this
  pulse_max_per_hour INTEGER NOT NULL DEFAULT 8,        -- hard cost guard
  pulse_jitter_pct INTEGER NOT NULL DEFAULT 5,
  max_concurrency INTEGER NOT NULL DEFAULT 1,
  enabled INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
);

CREATE TABLE missions (                     -- versioned; never edited in place
  id TEXT PRIMARY KEY, agent_name TEXT NOT NULL, version INTEGER NOT NULL,
  who_md TEXT NOT NULL, what_md TEXT NOT NULL, how_md TEXT NOT NULL, laws_md TEXT NOT NULL,
  rendered_md TEXT NOT NULL, hash TEXT NOT NULL,
  note TEXT, created_at INTEGER NOT NULL, created_by TEXT NOT NULL,
  UNIQUE (agent_name, version)
);

CREATE TABLE profiles (                     -- compiled into a per-session runner home
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  runner_id TEXT NOT NULL REFERENCES runners(id),
  model_tier TEXT NOT NULL,
  permission_json TEXT NOT NULL DEFAULT '{}',   -- mode, allow/deny tool rules (runner-mapped)
  sandbox_json TEXT NOT NULL DEFAULT '{}',      -- runner sandbox knobs + executor expectations
  env_json TEXT NOT NULL DEFAULT '{}',          -- non-secret env
  secret_refs_json TEXT NOT NULL DEFAULT '[]',  -- resolved from host secret store at spawn
  mcp_json TEXT NOT NULL DEFAULT '{}',
  hooks_json TEXT NOT NULL DEFAULT '{}',
  skills_refs_json TEXT NOT NULL DEFAULT '[]',
  tool_allowlist_json TEXT NOT NULL DEFAULT '[]', -- which MCP tools this role sees (§8.6)
  version INTEGER NOT NULL, hash TEXT NOT NULL, created_at INTEGER NOT NULL
);

CREATE TABLE prompt_templates (             -- prompt assembly is versioned code, §8.2
  id TEXT PRIMARY KEY, name TEXT NOT NULL,  -- 'pulse','build','review','fix','handoff_request'
  version INTEGER NOT NULL, body TEXT NOT NULL, hash TEXT NOT NULL,
  section_order_json TEXT NOT NULL,         -- explicit, cache-stable order
  budget_json TEXT NOT NULL,                -- per-section token caps + truncation order
  created_at INTEGER NOT NULL, UNIQUE (name, version)
);

CREATE TABLE run_classes (                  -- the token/turn contract per kind of work, §8.4
  name TEXT PRIMARY KEY,                    -- 'pulse','spike','build','review','fix','qa','probe'
  context_tokens_cap INTEGER NOT NULL,
  max_turns INTEGER NOT NULL,
  max_tool_calls INTEGER NOT NULL,
  wall_clock_ms INTEGER NOT NULL,
  cost_cap_usd REAL NOT NULL,
  handoff_at_turns INTEGER NOT NULL,        -- trigger hand-off before the ceiling, §7.1
  handoff_at_context_pct INTEGER NOT NULL DEFAULT 70,
  default_tier TEXT NOT NULL
);

-- ─── sessions, runs, events ──────────────────────────────────────────────────
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  ticket_id TEXT REFERENCES tickets(id),
  role TEXT NOT NULL, run_class TEXT NOT NULL REFERENCES run_classes(name),
  runner_id TEXT NOT NULL REFERENCES runners(id),
  runner_version TEXT,
  runner_session_id TEXT,                   -- provider session / thread id
  executor_id TEXT NOT NULL REFERENCES executors(id),
  executor_ref TEXT,                        -- pid | container id | ssh target+pid
  model TEXT, model_tier TEXT, effort TEXT,
  workspace_id TEXT REFERENCES workspaces(id),
  session_root TEXT NOT NULL, home_dir TEXT NOT NULL,   -- private runner home, §11.3
  config_hash TEXT NOT NULL, mission_hash TEXT, doctrine_hash TEXT, toolset_hash TEXT,
  state TEXT NOT NULL,
  predecessor_session_id TEXT REFERENCES sessions(id),  -- hand-off chain
  handoff_in_id TEXT, handoff_out_id TEXT,
  raw_log_path TEXT NOT NULL, pty_log_path TEXT, tmux_target TEXT,
  raw_segment_offset INTEGER,               -- byte in raw_log_path where the current runner
                                            -- process's output starts; replay rebuilds from it
  mcp_token_hash TEXT NOT NULL,
  attach_lease_owner TEXT, attach_lease_expires_at INTEGER,
  turns INTEGER NOT NULL DEFAULT 0, tool_calls INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, cost_source TEXT NOT NULL DEFAULT 'reported', -- |'estimated'
  tokens_in INTEGER DEFAULT 0, tokens_out INTEGER DEFAULT 0,
  tokens_cache_read INTEGER DEFAULT 0, tokens_cache_write INTEGER DEFAULT 0,
  context_peak_tokens INTEGER,
  last_event_at INTEGER, started_at INTEGER, ended_at INTEGER,
  exit_reason TEXT, error_class TEXT, error_message TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX sessions_state_idx ON sessions(state, last_event_at);
CREATE INDEX sessions_ticket_idx ON sessions(ticket_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id), seq INTEGER NOT NULL,
  trigger TEXT NOT NULL,                    -- pulse|operator|orchestrator|retry|gate|handoff
  template_id TEXT REFERENCES prompt_templates(id),
  prompt_path TEXT NOT NULL, prompt_tokens_est INTEGER, prompt_tokens_actual INTEGER,
  -- the pinned input set: two runs are comparable iff every hash matches
  prompt_hash TEXT NOT NULL, context_hash TEXT NOT NULL, mission_hash TEXT,
  doctrine_hash TEXT, toolset_hash TEXT, config_hash TEXT,
  model TEXT, effort TEXT, base_sha TEXT,
  truncated_sections_json TEXT,
  state TEXT NOT NULL,                      -- running|ok|failed|timeout|interrupted|budget_stop
  attempt INTEGER NOT NULL DEFAULT 1, wasted INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  tool_calls INTEGER DEFAULT 0, error_class TEXT, error_message TEXT,
  idempotency_key TEXT UNIQUE, UNIQUE (session_id, seq)
);

CREATE TABLE events (                       -- canonical, append-only, runner-agnostic
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT REFERENCES runs(id),
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,                       -- see §5.2 taxonomy
  runner_type TEXT NOT NULL,                -- raw type, kept verbatim for forensics
  tool_name TEXT, status TEXT, exit_code INTEGER,
  text TEXT,                                -- human-readable projection
  payload_json TEXT, payload_path TEXT,     -- big payloads live on disk, §8.5
  bytes_original INTEGER, truncated INTEGER NOT NULL DEFAULT 0,
  raw_offset INTEGER,
  UNIQUE (session_id, runner_type, raw_offset)
);
CREATE INDEX events_session_idx ON events(session_id, id);
CREATE INDEX events_kind_idx ON events(kind, ts);

CREATE TABLE spend (                        -- one row per run; the billing truth, §8.9
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id), session_id TEXT NOT NULL REFERENCES sessions(id),
  ticket_id TEXT REFERENCES tickets(id), gate_id TEXT, pulse_id TEXT,
  phase TEXT NOT NULL,                      -- = run_class
  runner_id TEXT NOT NULL, model TEXT NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  tokens_cache_read INTEGER NOT NULL DEFAULT 0, tokens_cache_write INTEGER NOT NULL DEFAULT 0,
  tokens_tool_result INTEGER,               -- attributed share from tool outputs, §8.5
  cost_usd REAL NOT NULL, cost_source TEXT NOT NULL,
  cache_hit_ratio REAL, wasted INTEGER NOT NULL DEFAULT 0, ts INTEGER NOT NULL
);
CREATE INDEX spend_ticket_idx ON spend(ticket_id);
CREATE INDEX spend_ts_idx ON spend(ts);

-- ─── tickets ─────────────────────────────────────────────────────────────────
CREATE TABLE tickets (
  id TEXT PRIMARY KEY, num INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL, body_md TEXT NOT NULL DEFAULT '', acceptance_md TEXT NOT NULL DEFAULT '',
  type TEXT NOT NULL CHECK (type IN ('bug','feature','chore','docs','spike','followup')),
  status TEXT NOT NULL, priority INTEGER NOT NULL DEFAULT 3,
  non_trivial INTEGER NOT NULL DEFAULT 0,
  complexity_score INTEGER NOT NULL DEFAULT 0,   -- deterministic rubric, §8.8
  complexity_tier TEXT NOT NULL DEFAULT 'standard',
  complexity_factors_json TEXT,                  -- why it scored that way (auditable)
  workspace_id TEXT REFERENCES workspaces(id), epic_id TEXT REFERENCES tickets(id),
  origin TEXT NOT NULL, origin_ref TEXT, origin_fingerprint TEXT,  -- dedupe noise, §10.2
  needs_human INTEGER NOT NULL DEFAULT 0,
  blocked_reason TEXT, unblock_condition TEXT,
  owner_session_id TEXT REFERENCES sessions(id),
  branch TEXT, plan_path TEXT, pr_url TEXT,
  review_rounds INTEGER NOT NULL DEFAULT 0, handoff_count INTEGER NOT NULL DEFAULT 0,
  -- auto-slicing (§7.5)
  parent_ticket_id TEXT REFERENCES tickets(id),   -- set on children of a split
  split_depth INTEGER NOT NULL DEFAULT 0,         -- max 2
  split_reason TEXT, split_from_handoff_id TEXT,  -- the packet whose next-steps became children
  children_total INTEGER NOT NULL DEFAULT 0, children_done INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0, cost_wasted_usd REAL NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, closed_at INTEGER
);
CREATE INDEX tickets_status_idx ON tickets(status, priority, updated_at);
CREATE INDEX tickets_needs_human_idx ON tickets(needs_human) WHERE needs_human = 1;
CREATE UNIQUE INDEX tickets_origin_fp_idx ON tickets(origin_fingerprint)
  WHERE origin_fingerprint IS NOT NULL;

-- ─── coordination: commands ──────────────────────────────────────────────────
CREATE TABLE commands (
  id TEXT PRIMARY KEY, ts INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL,
  idempotency_key TEXT UNIQUE, state TEXT NOT NULL DEFAULT 'pending',
  claimed_at INTEGER, attempts INTEGER DEFAULT 0, result_json TEXT, error TEXT
);
CREATE INDEX commands_pending_idx ON commands(state, ts);

-- ─── infra ───────────────────────────────────────────────────────────────────
CREATE TABLE supervisor_state (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL);

CREATE TABLE settings (                     -- operator-tunable knobs (retention, autosplit, policy)
  key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at INTEGER NOT NULL
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, target_kind TEXT, target_id TEXT, payload_json TEXT, ip TEXT
);

-- ─── views (§4.1) ────────────────────────────────────────────────────────────
CREATE VIEW v_fleet AS
  SELECT s.id, a.name AS agent, s.role, s.run_class, s.state, s.runner_id, s.executor_id,
         s.model_tier, t.num AS ticket, t.title, s.turns, s.cost_usd,
         (unixepoch()*1000 - s.last_event_at) AS idle_ms
  FROM sessions s JOIN agents a ON a.id = s.agent_id
  LEFT JOIN tickets t ON t.id = s.ticket_id
  WHERE s.state NOT IN ('exited','resumable','handed_off');
