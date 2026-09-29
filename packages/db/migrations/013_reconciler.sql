-- 013_reconciler (M4): what reconciler v1 reads across a restart (spec §9.6, "Amendments
-- — M4"; the design §8). It adds:
--   sessions.spawn_request_json  the zod-parsed session.spawn payload a pending session was created
--               from, so a restart can re-admit it (§9.1). Supervisor-owned (§9.5). NULL for the
--               supervisor's internal spawns, for rows made before 013, and once admitted.
--   runs.wall_clock_ms  the wall clock the run armed, so a restart judges a run's timeout by the
--               budget it pinned (§5.2), never by today's run class. NULL for runs before 013.
--   settings    reconciler.command_max_attempts: the claims one command gets before it is failed
--               (the command requeue amendment), INSERT OR IGNORE as in 011 and 012.
ALTER TABLE sessions ADD COLUMN spawn_request_json TEXT;
ALTER TABLE runs ADD COLUMN wall_clock_ms INTEGER;

INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('reconciler.command_max_attempts', '3', unixepoch() * 1000);
