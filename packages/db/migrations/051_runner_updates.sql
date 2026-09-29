-- 051_runner_updates: the runner update check. A runner's adapter may declare
-- `updateCheck`, one unauthenticated GET of its own package's latest release on npm; nothing here
-- ever installs or runs anything.
--
-- runner_updates (supervisor-owned, §9.5): one row per (runner, latest) it has ever seen. `newer`
-- is core `compareVersions(latest, current) > 0`, recomputed every check; `found_at` is set once,
-- on the row's first insert, and never touched again -- an upsert by (runner_id, latest) updates
-- `current`, `newer` and `checked_at` on every later sight, but not `found_at`. After an upgrade
-- and restart the boot pass rewrites the same row with `newer = 0`, and the item clears.
CREATE TABLE runner_updates (
  runner_id  TEXT NOT NULL REFERENCES runners(id),
  latest     TEXT NOT NULL CHECK (length(latest) BETWEEN 1 AND 64),
  current    TEXT NOT NULL CHECK (length(current) BETWEEN 1 AND 64),
  newer      INTEGER NOT NULL CHECK (newer IN (0, 1)),
  notes_url  TEXT CHECK (notes_url IS NULL OR (substr(notes_url, 1, 8) = 'https://' AND length(notes_url) <= 500)),
  found_at   INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  PRIMARY KEY (runner_id, latest)
);

-- runner_update_dismissals (API-owned, §9.5): the operator's dismissal of one (runner, latest) row,
-- audited as `runner_update.dismiss`. Cascades with the row it dismisses, since a version that was
-- never seen has nothing to dismiss.
CREATE TABLE runner_update_dismissals (
  runner_id    TEXT NOT NULL,
  latest       TEXT NOT NULL,
  dismissed_at INTEGER NOT NULL,
  dismissed_by TEXT NOT NULL,
  PRIMARY KEY (runner_id, latest),
  FOREIGN KEY (runner_id, latest) REFERENCES runner_updates (runner_id, latest) ON DELETE CASCADE
);

-- runners.update_check_hours (core OPERATOR_SETTINGS): how often the check runs; 0 is off. An
-- operator's own pre-set value, if PATCHed before this migration somehow ran, survives (INSERT OR
-- IGNORE), matching every other seeded setting.
INSERT OR IGNORE INTO settings (key, value_json, updated_at)
VALUES ('runners.update_check_hours', '24', unixepoch() * 1000);
