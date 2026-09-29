# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# foreman — repo doctrine

Control plane for a fleet of coding agents. Supervisor daemon owns agent processes, SQLite is the
system of record, NestJS serves the API + an MCP server for agents, React/Vite is the GUI.

**Status:** milestones M0–M12 are done (M11 parked); see the README's "Where it stands". Acceptance
smokes: `pnpm frm smoke`, `--m1` … `--m4` (and the real `--m2 --runner sdk`).

**No container host is assumed.** Container-executor code and its unit tests are kept, but every
acceptance path that needs a docker host — `FRM_CONTAINER=1 … --m3 --executor <name>`, a gate or
conformance run on a container, `deploy/bayon.sh` — needs one you provide. Say plainly in a PR when
such a path was not run rather than implying coverage.

**Sources of truth.** The architecture spec and the ticket tracker are kept outside this repo.
Spec sections are cited as `§n.n` throughout the code and this file. One ticket = one session =
branch `agent/<ticket>`.

This file is the working agreement; when it disagrees with the spec, the spec wins and you fix this
file in the same PR. Do not restate the spec here — cite sections (`§7.5`) instead. Keep this file
under 200 lines: every line costs tokens on every turn of every session.

## Stack

TypeScript strict · pnpm workspaces · Node 22 LTS · NestJS · Vite + React + Tailwind v4 + TanStack Query
· better-sqlite3 + Kysely (no ORM) · zod at every boundary · Vitest · node-pty + tmux for takeover.

GUI (2026-09-24): Tokyo Night / Day, Geist + JetBrains Mono; follows the system until the operator
picks (`public/theme-init.js`, before first paint). Blue is primary; green means success only.
shadcn + base-ui in `components/ui/` (never hand-roll what base-ui has); app primitives in
`components/`: states via `status.ts` + StatusBadge, PageHeader, TextLink, Field, Loading,
QueryError, `notify` toasts; `primitives-guard.test.ts` keeps them the only way. `theme.css`: one
semantic mapping over per-theme primitives; name tokens, never literals (`colours.test.ts`, AA).

```
apps/api            NestJS: REST + WS + /mcp
apps/supervisor     daemon: scheduler, ingest, reconciler, watchdog, prompt compiler
apps/web            GUI
packages/core       domain types, canonical events, run classes, hashing, prompt compiler
packages/db         migrations, Kysely types, repositories — the ONLY place SQL lives
packages/runners    RunnerAdapter interface, adapters, conformance suite
packages/executors  Executor interface, local/container/remote
packages/proto      shared DTOs (zod) used by api + web + supervisor
tools/frm           operator CLI
docs/spikes/        per-ticket plans written by agents (see How to work a ticket)
```

## How it fits together

- A session = runner × executor × workspace (§2). Agents are children of the supervisor, never the
  API — an API restart must kill nothing.
- Control: GUI/`frm` → API inserts a `commands` row → supervisor claims it (poll + unix-socket
  notify, `idempotency_key`) → spawn pipeline (§9.1): admission → worktree from mirror clone →
  runner home materialized from `profiles` → `adapter.spawn` on an executor.
- Data (§9.4): runner stream → raw bytes to `raw_log_path` → adapter maps to canonical events →
  batched into `events`, idempotent on `(session_id, runner_type, raw_offset)` → API WS topics
  replay from an `events.id` cursor, then go live (§12.2).
- Agents write back only via `/mcp` (per-session token, role-scoped tools, §11.1); the operator via
  REST. Both are API doors, so every write is attributable.
- Reconciler (§9.6 + M0 amendments), at boot and every 60 s: adopt resumable dead sessions via
  resume (a live but unattached process is killed first), mark the rest `exited(error)`; ingest
  replays the raw log from `raw_segment_offset`. This is what makes supervisor restarts lossless.

## Invariants — do not violate without changing the spec first

1. **No runner/provider specifics outside `packages/runners/<adapter>`.** No `claude`/`codex` string
   anywhere else — not in api, supervisor, web, db. Everything else speaks the canonical event
   taxonomy (§5.2) and the capability matrix (§5.1).
2. **Never parse a runner's internal transcript files.** Stream + hooks are the contract (§App. A).
3. **A run ends only on a `terminal` event.** No terminal event inside the wall-clock budget = failure
   (§5.2). Never infer success from exit code, never infer liveness from CPU.
4. **Unknown events are stored, never dropped** (`kind='runner_native'`, raw payload kept).
5. **Writer discipline** (§9.5): supervisor writes sessions/runs/events/spend/pulses/approvals/
   worktrees/qa/backups/deliveries/runner_updates (+ `tickets.pr_url` and `ticket_links`, its third
   ticket write beside blockTicket and advanceTicket); API writes tickets/gates/findings/missions
   (+ `agents.mission_id`)/messages/handoffs/knowledge/budgets/runner_update_dismissals; API inserts
   `commands`, supervisor claims them. Never cross. `tools/frm` alone writes via `@bayon/db/operator`: config, backups (the API may only append a `projects.local_roots` folder for a browser on the host, §14).
6. **All SQL lives in `packages/db`.** No query strings in apps. Migrations are forward-only numbered
   files; every migration has a test that runs it on an empty DB and on a seeded DB.
7. **No compaction — hand off** (§7, §8.7). One unit of work per session.
8. **Prompts are compiled from versioned templates** (§8.2). String-concatenating a prompt at a call
   site is a bug. Every run records its input hashes (§8.1).
9. **Every tool result is capped** (§8.5): 8 KB / 200 lines, full text to disk, path handed back.
   Applies to our own MCP tool responses too.
10. **Gates require evidence** (§10.3). A gate cannot be `passed` without command, exit code, duration,
    cost and artifact paths. Transition laws are enforced server-side, table-driven, not in prompts.
11. **Secrets** come from the host secret store into a child's env at spawn. Never in the DB, a
    prompt, an event payload, a worktree, or a log (§14). Two files are named exceptions: a
    credential written into a session's private home for the runner to read, and a credential read
    from and returned to a path the operator granted (`settings.runners.login_in_place`, off by
    default, shell-only) — for a login whose own CLI rotates it, which a stored copy cannot track.
    At use the API reads `JIRA_API_TOKEN` (Basic, `*.atlassian.net` only) and the `NOTIFY_*` URLs,
    the supervisor `FORGE_TOKEN_<KIND>` (https, own forge host, local git only): never stored/logged.
12. **One process per runner session id.** Leases enforce it (§12.5).

## Conventions

- IDs are ULID `TEXT`. Timestamps are epoch-millis `INTEGER` UTC. Money is `REAL` USD; tokens are
  `INTEGER`. No `DATETIME`, no floats for counts.
- Errors: typed union `{ class, message, retryable, cause? }`. `error_class` values are a closed enum
  in `packages/core`. No thrown strings, no `any` in a catch.
- zod-parse everything crossing a boundary (HTTP, WS, MCP, runner stdout, config files). Types
  inferred from schemas, never hand-written twice.
- SQLite pragmas on every open: `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000`,
  `foreign_keys=ON`. **Do not raise `busy_timeout` to fix contention** — fix the batching (§9.5).
- Event ingest batches: 50 ms or 100 rows, one transaction. Never one insert per event.
- No `localStorage` for anything that must survive; the DB is the store.
- Config over code for anything that changes monthly: models, run classes, role bindings, probes,
  retention, thresholds all live in tables (§4), never as constants.
- Commits: `type(scope): subject` with the ticket key, e.g. `feat(db): 003 work tables`.
  No attribution trailers — no Co-Authored-By, no Claude-Session line — in commits or PR bodies.

## How to work a ticket

1. **Read** the ticket and the spec sections it cites. If the ticket contradicts the spec, stop and
   say so on the ticket.
2. **Plan** for anything non-trivial: write `docs/spikes/<ticket>.md` with approach, files touched,
   test plan, risks. **No feature code in that commit** — the plan gets reviewed first (§10.3).
3. **Build** in small commits, tests alongside.
4. **Verify, then claim.** Paste real output — `pnpm -w typecheck`, `pnpm -w test`, `pnpm -w lint`,
   and for db work the migration up/down run. "Should work" is not evidence.
5. **Hand off** if you hit a ceiling: write what you'd want to receive (§7.2) — facts, decisions,
   traps, next 3 steps.

Definition of done: acceptance criteria met · tests written and passing · typecheck + lint clean ·
migration reversible where applicable · no new `any` · no runner strings outside adapters · evidence
pasted in the PR.

## Testing

- Unit: pure logic in `packages/core` (event mapping, prompt compiler, budget checks, transition laws)
  — these are the ones worth 100 % branch coverage.
- Integration: `packages/db` against a real temp SQLite file (never `:memory:` for WAL behaviour);
  supervisor ingest against recorded JSONL fixtures in `packages/runners/fixtures/`.
- Runner conformance (§15) is the acceptance test for any adapter; tests 9, 10 and 14 are
  non-negotiable.
- Golden tasks (§8.10) come later but keep fixtures shaped for them from the start.
- Fake time with a clock injected via DI. No `sleep` in tests.

## Things that look right and are wrong

- Adding a `claude`-specific flag to `SpawnSpec` "just for now" → it never comes out. Put it in the
  adapter's `defaults_json`.
- Storing a whole tool output in `events.payload_json` → that is the token and disk bill both. Path.
- Blocking a session on a human answer → `human.ask` is non-blocking by design (§11.1).
- "The agent will follow the law in the mission note" → put it in the server too (§10.3, §3.2).
- Fixing a flaky QA spec by updating the visual baseline → baselines change only by operator action
  (§10.4).
- Deleting a dirty worktree to tidy up → never; work in progress is preserved (§9.2).
- Adding a native dependency (better-sqlite3, node-pty) without an `allowBuilds` entry in
  `pnpm-workspace.yaml` → pnpm 11 refuses its build script. Approve it there in the same PR.

## Commands

```bash
pnpm i && pnpm -w build
pnpm -w typecheck && pnpm -w lint && pnpm -w test
pnpm exec vitest run <file> -t '<name>'   # one test, from the repo root
FRM_HOME=… pnpm --filter @bayon/db migrate:up | migrate:down | migrate:status  # or --db / FRM_DB
FRM_HOME=… pnpm --filter @bayon/supervisor dev            # daemon: control socket + claimer
FRM_HOME=… FRM_API_TOKEN=… pnpm --filter @bayon/api start  # REST /api/v1 + /ws
FRM_API_TOKEN=… pnpm --filter @bayon/web dev               # :5173, proxies /api + /ws, adds the bearer
FRM_HOME=… pnpm frm settings get [key] | set <key> <value> [--yes]  # shell-only: the one door to the security controls (the GUI shows them read-only), except appending a local root from a browser on the host (POST /folders/allow); audited, security keys need --yes
pnpm frm smoke [--hang] [--runner sdk]  # M0 acceptance; sdk needs FRM_REAL_RUNNER=1 + a key
pnpm frm smoke --m1                     # M1 acceptance: ticket read/update/file over /mcp, laws, export
pnpm frm smoke --m2                     # M2 acceptance: pulses staff one ticket through 3 hand-offs, no operator
FRM_REAL_RUNNER=1 FRM_SECRET_CLAUDE_CODE_OAUTH_TOKEN=… pnpm frm smoke --m2 --runner sdk  # M2 real check: $2 cap, 2-turn ceiling
pnpm frm smoke --m3                     # M3 acceptance: conformance, review rounds with evidence, QA override, timeout retry, a real parity_check on a multi-repo ticket
FRM_CONTAINER=1 pnpm frm smoke --m3 --executor <name>   # NO HOST TODAY (see Status): reviewer on a container, canary, egress, labelled cleanup
pnpm frm smoke --m4                     # M4 acceptance: budget and pause each queue a spawn, then the plug pulled twice — adopted, requeued, raw logs whole
FRM_REAL_RUNNER=1 FRM_SECRET_CLAUDE_CODE_OAUTH_TOKEN="$(security find-generic-password -s foreman -a CLAUDE_CODE_OAUTH_TOKEN -w)" pnpm frm smoke --runner sdk  # no key: OAuth, token from `claude setup-token`, stored once with `security add-generic-password -s foreman -a CLAUDE_CODE_OAUTH_TOKEN -w`
BAYON_HOST=ops@<docker-host> BAYON_ADDR=<lan-address> deploy/bayon.sh build <ref> | install <project> <sha12> | upgrade <project> <sha12>  # NO HOST TODAY (see Status): Bayon itself on the docker host
BAYON_HOST=… deploy/bayon.sh frm <project> <frm args…> | inventory | down bayon-stg -v  # NO HOST TODAY: frm in the supervisor container; label-scoped only
security add-generic-password -U -s foreman -a JIRA_API_TOKEN -w "$(pbpaste)"  # Keychain service per install: `foreman` is the default home's (~/.foreman) alone, any other FRM_HOME reads `foreman-<12 hex of its realpath's sha256>` (GET /jira and the GUI name it; tests get a stand-in `security`). The Jira mirror's token, copied first (the -w prompt cuts at 128; `find-generic-password … -w | wc -c` ≈ 190), read at each sync; PATCH /projects/<p> {"jira": {url, email, jql}}, POST /projects/<p>/jira/sync
sudo /srv/bayon/<project>/secrets.sh init | put | gen | ssh-key | password | list <project> …  # on the host: the file secret store; never prints a value
```

## Hooks

- Wired in `.claude/settings.json`: `PreToolUse` on Write/Edit blocks changes to a
  `packages/db/migrations/*` file that is already on `origin/main` — add a new file instead.
- Not wired (CI covers them): post-edit `tsc`, a `Stop` typecheck/new-`any` gate, a `SessionStart` summary.
