-- Reverts 018_runs_ended_at_index: the scans go back to driving the join from sessions.
DROP INDEX ix_runs_state_ended_at;
