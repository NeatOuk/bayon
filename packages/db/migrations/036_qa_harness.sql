-- 036_qa_harness (M7.5): a project's QA harness, and the runs of it.
--
-- §10.4's QA has had no writer since M3 ("qa gates land in M5"), so `qa_passed` could only ever be
-- satisfied by the operator's override with a note. This gives it one: a project declares a command,
-- `pass_review` opens a `qa_harness` gate as the ticket enters that status, the gate runs the command
-- and every decision of it writes a row here for the laws to read.
--
-- What Bayon knows about a project's QA is one thing: **a command that exits non-zero when the
-- project is broken.** No framework, no file layout, no report format and no naming convention.
--
--   workspaces.qa_mode         'none' (every project already here), 'command' or 'pending'.
--              'pending' means the operator asked Bayon to build a harness -- a ticket is filed from
--              the `qa_harness_request` template and the mode stays put until the operator switches
--              it, because nothing here can know the work landed. NOT NULL with a default because
--              SQLite needs one to add a NOT NULL column, and because "no column" and "this project
--              runs no harness" are the same statement.
--   workspaces.qa_cmd          the argv, run with no shell, the rule `repos.lint_cmd` is held to,
--              plus the placeholders {ticket}, {external_key} and {branch} (core `qaArgv`).
--   workspaces.qa_timeout_ms   the harness's own wall clock; NULL is core's 20-minute default.
--   workspaces.qa_secrets_json host-store secret NAMES to inject into the harness's env, JSON array.
--              Never a value: §14, Invariant 11.
--   workspaces.qa_reports_json globs, relative to the worktree, attached to the gate as evidence.
--   workspaces.qa_junit        one path or glob to a JUnit XML report, for a finding per failed case.
--
-- The CHECK is on the last column added, as 032's and 033's pairs are: a mode of 'command' must have
-- a command, because a gate whose command is blank could only ever fail. The other four are free:
-- a project may configure them before it switches the mode on.
ALTER TABLE workspaces ADD COLUMN qa_mode TEXT NOT NULL DEFAULT 'none';
ALTER TABLE workspaces ADD COLUMN qa_cmd TEXT;
ALTER TABLE workspaces ADD COLUMN qa_timeout_ms INTEGER;
ALTER TABLE workspaces ADD COLUMN qa_secrets_json TEXT;
ALTER TABLE workspaces ADD COLUMN qa_reports_json TEXT;
ALTER TABLE workspaces ADD COLUMN qa_junit TEXT
  CHECK (qa_mode IN ('none','command','pending')
         AND (qa_mode <> 'command' OR (qa_cmd IS NOT NULL AND trim(qa_cmd) <> '')));

-- The supervisor's table (§9.5's `qa`, Invariant 5). One row per **decision** of a `qa_harness`
-- gate, not per command that ran: a gate that failed before the harness started (no reviewer, a
-- timeout, a restart) writes `error` with no command, so the newest row always speaks for the newest
-- attempt. Without that, a stale `passed` from attempt 1 would carry a failed attempt 2 past
-- `qa_passed`.
--
-- Three states, not the archived spec's six: `queued` and `running` have no reader (the `gates` row
-- is the state machine), and `flaky` needs a re-run policy that does not exist. `error` is the one
-- that earns its place -- it is what keeps a harness that COULD NOT RUN from reading as a harness
-- that found a bug.
CREATE TABLE qa_runs (
  id TEXT PRIMARY KEY,
  ticket_id TEXT NOT NULL REFERENCES tickets(id),
  gate_id TEXT REFERENCES gates(id),
  state TEXT NOT NULL CHECK (state IN ('passed','failed','error')),
  -- The project's own command, placeholders filled, as run; NULL when nothing ran.
  command TEXT,
  exit_code INTEGER,
  -- The report files the gate attached, as paths under its artifacts directory (JSON array).
  report_paths_json TEXT NOT NULL DEFAULT '[]',
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

-- What `facts.qa` asks: the newest row for one ticket. `id` breaks a tie, since two rows can share a
-- millisecond and a ULID's random suffix is not an ordering.
CREATE INDEX qa_runs_ticket_idx ON qa_runs(ticket_id, started_at DESC, id DESC);
