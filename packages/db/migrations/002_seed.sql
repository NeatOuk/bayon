-- 002_seed: the run classes (§8.4, amendment 5; 0 = n/a) and the operator settings (§4, plus
-- amendment 8's budget cap, where null means no cap). No runner or model rows: those come from
-- each adapter's registration() at supervisor boot (amendment 4, Invariant 1).
-- The run_classes rows must equal @bayon/core's DEFAULT_RUN_CLASSES (seed.test.ts checks).
INSERT INTO run_classes (name, context_tokens_cap, max_turns, max_tool_calls, wall_clock_ms,
                         cost_cap_usd, handoff_at_turns, handoff_at_context_pct, default_tier)
VALUES
  ('pulse',          6000,  12,   40,   900000, 0.5,  10, 70, 'cheap'),
  ('spike',         15000,  40,  120,  2700000, 2,    30, 70, 'standard'),
  ('build',         25000, 120,  500,  7200000, 6,    90, 70, 'standard'),
  ('build_complex', 40000, 250, 1200, 14400000, 15,  180, 70, 'complex'),
  ('review',        30000,  30,   80,  1800000, 3,     0,  0, 'standard'),
  ('fix',           15000,  60,  200,  3600000, 2,    45, 70, 'standard'),
  ('qa',                0,   0,    0,  1200000, 0.2,   0,  0, 'cheap'),
  ('probe',             0,   0,    0,    30000, 0,     0,  0, 'cheap');

INSERT INTO settings (key, value_json, updated_at)
VALUES
  ('retention.reasoning',             '"keep"', unixepoch() * 1000),
  ('retention.events_days',           '30',     unixepoch() * 1000),
  ('retention.qa_video_days',         '14',     unixepoch() * 1000),
  ('autosplit.enabled',               '1',      unixepoch() * 1000),
  ('autosplit.handoff_threshold',     '4',      unixepoch() * 1000),
  ('autosplit.max_children',          '5',      unixepoch() * 1000),
  ('autosplit.max_depth',             '2',      unixepoch() * 1000),
  ('roles.require_distinct_reviewer', '1',      unixepoch() * 1000),
  ('budget.daily_cap_usd',            'null',   unixepoch() * 1000);
