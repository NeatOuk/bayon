-- 014_watchdog (M4): what the watchdog's system human_requests need (spec §13.2,
-- "Amendments — M4"; the design §2.1, §8). It adds:
--   human_requests.dedupe_key  `<rule>:<subject>:<window>` of a request the supervisor's named
--               writer insertSystemHumanRequest filed (circuit breaker, split question, retry storm;
--               M4-c's blocked pulse); NULL on every human_ask row. The index is plain, never partial:
--               ON CONFLICT (dedupe_key) cannot target a partial index, and NULLs are distinct under
--               a unique index, so human_ask's rows coexist.
ALTER TABLE human_requests ADD COLUMN dedupe_key TEXT;
CREATE UNIQUE INDEX human_requests_dedupe_idx ON human_requests(dedupe_key);
