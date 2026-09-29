-- Reverts 017_run_class_ceilings: 002's values come back only on a row that still holds exactly
-- 017's, in every column. A row the operator tuned after 017 keeps the operator's values.
UPDATE run_classes
SET context_tokens_cap = 15000, max_turns = 40, max_tool_calls = 120, cost_cap_usd = 2,
    handoff_at_turns = 30
WHERE name = 'spike'
  AND context_tokens_cap = 150000 AND max_turns = 100 AND max_tool_calls = 300
  AND wall_clock_ms = 2700000 AND cost_cap_usd = 5 AND handoff_at_turns = 75
  AND handoff_at_context_pct = 70 AND default_tier = 'standard';

UPDATE run_classes
SET context_tokens_cap = 25000, max_turns = 120, max_tool_calls = 500, cost_cap_usd = 6,
    handoff_at_turns = 90
WHERE name = 'build'
  AND context_tokens_cap = 300000 AND max_turns = 300 AND max_tool_calls = 1200
  AND wall_clock_ms = 7200000 AND cost_cap_usd = 15 AND handoff_at_turns = 225
  AND handoff_at_context_pct = 70 AND default_tier = 'standard';

UPDATE run_classes
SET context_tokens_cap = 15000, max_turns = 60, max_tool_calls = 200, cost_cap_usd = 2,
    handoff_at_turns = 45
WHERE name = 'fix'
  AND context_tokens_cap = 150000 AND max_turns = 150 AND max_tool_calls = 500
  AND wall_clock_ms = 3600000 AND cost_cap_usd = 5 AND handoff_at_turns = 112
  AND handoff_at_context_pct = 70 AND default_tier = 'standard';

UPDATE run_classes
SET context_tokens_cap = 40000, max_turns = 250, max_tool_calls = 1200, cost_cap_usd = 15,
    handoff_at_turns = 180
WHERE name = 'build_complex'
  AND context_tokens_cap = 600000 AND max_turns = 500 AND max_tool_calls = 2000
  AND wall_clock_ms = 14400000 AND cost_cap_usd = 30 AND handoff_at_turns = 375
  AND handoff_at_context_pct = 70 AND default_tier = 'complex';

UPDATE run_classes
SET context_tokens_cap = 30000, max_turns = 30, max_tool_calls = 80, cost_cap_usd = 3
WHERE name = 'review'
  AND context_tokens_cap = 150000 AND max_turns = 60 AND max_tool_calls = 200
  AND wall_clock_ms = 1800000 AND cost_cap_usd = 5 AND handoff_at_turns = 0
  AND handoff_at_context_pct = 0 AND default_tier = 'standard';
