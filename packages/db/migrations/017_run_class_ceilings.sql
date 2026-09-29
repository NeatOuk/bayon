-- 017_run_class_ceilings (M4): the seeded run classes a real coding-agent session can
-- start under. 002's rows were only ever exercised by the fixture runner; a real session spends
-- roughly 15-25k tokens on its own system prompt and tool definitions before it reads a file, and
-- the dogfood pilot's spike ran out at 15k.
--
-- Each UPDATE matches a row on every column of its 002 value, so a row the operator tuned (any
-- column changed, by `frm config apply` or by hand) is never overwritten. pulse, qa and probe are
-- untouched: the pulse's context pack is built to its 6k cap and it runs with no built-in tools.
-- core's DEFAULT_RUN_CLASSES holds the same values (seed.test.ts).
--
-- name            context  turns  tools  wall clock  cost  hand-off turns  hand-off ctx %
-- spike           150000    100    300    2700000      5        75             70
-- build           300000    300   1200    7200000     15       225             70
-- fix             150000    150    500    3600000      5       112             70
-- build_complex   600000    500   2000   14400000     30       375             70
-- review          150000     60    200    1800000      5         0              0
UPDATE run_classes
SET context_tokens_cap = 150000, max_turns = 100, max_tool_calls = 300, cost_cap_usd = 5,
    handoff_at_turns = 75
WHERE name = 'spike'
  AND context_tokens_cap = 15000 AND max_turns = 40 AND max_tool_calls = 120
  AND wall_clock_ms = 2700000 AND cost_cap_usd = 2 AND handoff_at_turns = 30
  AND handoff_at_context_pct = 70 AND default_tier = 'standard';

UPDATE run_classes
SET context_tokens_cap = 300000, max_turns = 300, max_tool_calls = 1200, cost_cap_usd = 15,
    handoff_at_turns = 225
WHERE name = 'build'
  AND context_tokens_cap = 25000 AND max_turns = 120 AND max_tool_calls = 500
  AND wall_clock_ms = 7200000 AND cost_cap_usd = 6 AND handoff_at_turns = 90
  AND handoff_at_context_pct = 70 AND default_tier = 'standard';

UPDATE run_classes
SET context_tokens_cap = 150000, max_turns = 150, max_tool_calls = 500, cost_cap_usd = 5,
    handoff_at_turns = 112
WHERE name = 'fix'
  AND context_tokens_cap = 15000 AND max_turns = 60 AND max_tool_calls = 200
  AND wall_clock_ms = 3600000 AND cost_cap_usd = 2 AND handoff_at_turns = 45
  AND handoff_at_context_pct = 70 AND default_tier = 'standard';

UPDATE run_classes
SET context_tokens_cap = 600000, max_turns = 500, max_tool_calls = 2000, cost_cap_usd = 30,
    handoff_at_turns = 375
WHERE name = 'build_complex'
  AND context_tokens_cap = 40000 AND max_turns = 250 AND max_tool_calls = 1200
  AND wall_clock_ms = 14400000 AND cost_cap_usd = 15 AND handoff_at_turns = 180
  AND handoff_at_context_pct = 70 AND default_tier = 'complex';

UPDATE run_classes
SET context_tokens_cap = 150000, max_turns = 60, max_tool_calls = 200, cost_cap_usd = 5
WHERE name = 'review'
  AND context_tokens_cap = 30000 AND max_turns = 30 AND max_tool_calls = 80
  AND wall_clock_ms = 1800000 AND cost_cap_usd = 3 AND handoff_at_turns = 0
  AND handoff_at_context_pct = 0 AND default_tier = 'standard';
