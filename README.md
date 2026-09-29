# Bayon

Control plane for a fleet of coding agents (codename foreman). You give it tickets. It runs AI
coding agents against your repos (Claude through the Agent SDK, open models through OpenCode and
Ollama, and Codex) and keeps them honest: an agent can't pass a review without evidence, can't see
a secret it wasn't given, and can't spend past a budget you set.

A supervisor daemon owns the agent processes, SQLite is the system of record, a NestJS API serves
REST, WebSocket and an MCP server for the agents, and a React GUI sits on top.

This README is the overview and the reference: what Bayon is, where it stands, how to set it up, and
what to reach for once it's running.

- Working on the code: read [CLAUDE.md](CLAUDE.md) first.

## How it fits together

```
        you
   +-----+------+
   |            |
 GUI :5173    frm CLI
 (browser)    (terminal)
   |            |
   +-----+------+
         | REST + WebSocket, bearer token
         v
+-------------------------------------+
| API                  127.0.0.1:3010 |<------------------------------+
| REST /api/v1   WS /ws   MCP /mcp    |                               |
+------------------+------------------+                               |
                   | writes tickets, gates, findings;                 |
                   | inserts commands                                 |
                   v                                                  |
+-------------------------------------+                               |
| SQLite         $FRM_HOME/foreman.db |  the system of record         |
+------------------+------------------+                               |
                   ^ claims commands; writes sessions,                |
                   | runs, events, spend                              |
+------------------+------------------+                               |
| Supervisor (daemon)                 |                               |
|  admission -> worktree -> spawn     |                               |
|  ingest, reconciler, pulses         |                               |
|  gates, backups                     |                               |
+--------+--------------------+-------+                               |
         |                    | ssh                                   |
         v                    v                                       |
+-----------------+  +---------------------------+                    |
| local executor  |  | container executor        |                    |
| this machine    |  | docker host; every object |                    |
|                 |  | labelled frm.managed=1    |                    |
+--------+--------+  +-------------+-------------+                    |
         |                         |                                  |
         v                         v                                  |
+-------------------------------------------------+                   |
| agent sessions = runner x executor x worktree   |-------------------+
| claude-sdk, opencode, codex-exec, fixture       |  agents write back only
+-------------------------------------------------+  through /mcp (per-session
                                                     token, role-scoped tools)
```

- **Control:** the GUI or `frm` asks the API. The API inserts a `commands` row, and the supervisor
  claims it: it runs admission, makes a worktree from a mirror clone of the repo, and spawns the
  runner on an executor.
- **Data:** a runner's output goes to a raw log on disk, gets mapped to canonical events, and lands
  in SQLite in batches. The GUI replays from a cursor over the WebSocket, then follows live.
- **Recovery:** agents are children of the supervisor, never of the API, so an API restart kills
  nothing. At boot the supervisor's reconciler adopts the sessions it can resume and ends the rest
  cleanly. Stopping or restarting the supervisor loses no work.

## Where it stands

Milestones M0 through M12 are done, except the parked M11 (install, routines, mobile, team view).
Bayon builds its own tickets day to day.

**What works:**

- **Core:** the API, the supervisor and the GUI survive restarts without losing sessions. Pause and
  resume, budgets, the audit trail, nightly encrypted backups and the worktree sweep all run.
- **Runners:** `claude-sdk` and `opencode` (open models on Ollama, local or cloud) are certified
  **per model** on the local executor, and so is `fixture`. `codex-exec` works but is unused.
- **Per project:** a project IDE with its own agents, orchestrator and history. The model tier is
  chosen per step (plan, build, review), and context compression is available.
- **Workflow:** a Jira mirror (one way in, with status write-back out), notifications, QA harness or
  CI as the QA gate, Confluence pages for agents, pushed branches and pull requests, and a merge
  that closes its ticket.
- **Keeping current:** a daily check says when a runner's SDK or CLI has a new release, and new
  `claude-*` models can be added from the GUI and certified before use.

**What doesn't yet:**

- The GUI of a Mac install has no login. Anyone who can open it has full control, which is why it
  binds to the Mac itself by default.
- With an Anthropic **API key** (not an OAuth token), the key is visible to the model's shell. OAuth
  is unaffected.
- There is no docker host today, so the container executor is built and unit-tested but not run.
  Terminal takeover is local-only.
- `codex-exec` can't act as a code reviewer: one conformance test fails against a real model.

**How agents behave once they have work:**

- The orchestrator wakes on a pulse (every 90 minutes by default), staffs tickets, and never does
  ticket work itself.
- A project's tickets are worked and reviewed only by that project's agents, which may run on
  different runners. Agents with no project step in only for a role the project has no agent for.
  If the project's own agents are busy, the ticket waits.
- A session never compacts its context. When it hits a limit (turns, context or cost), it writes a
  hand-off packet and a successor picks up in the same worktree.
- A ticket can't pass a review gate without evidence (command, exit code, cost, artifacts), and open
  blocking findings stop it from moving on. The GUI shows the round count.
- Agents see secrets only in their own environment, never in a prompt, a log or the database.

**Time and money:**

| Thing                                | Expect                                                  |
| ------------------------------------ | ------------------------------------------------------- |
| `pnpm -w build`, then the test suite | a few minutes each                                      |
| Each smoke test                      | about 2 to 3 minutes                                    |
| Certifying `fixture`                 | free                                                    |
| Certifying `claude-sdk`              | about $0.20, billed to your Claude credential           |
| Certifying `opencode`                | minutes on a local model; free apart from your hardware |
| Certifying `codex-exec`              | about 10 minutes of real calls on your Codex credential |
| Real agent work                      | billed the same way; the Fleet page shows today's spend |

## Platforms

On **macOS**, secrets live in the
Keychain under service `foreman`. That service belongs to the install in your default home,
`~/.foreman`, alone: a Bayon started with any other `FRM_HOME` (a second install, a scratch copy, a
test) reads its own service, `foreman-<12 hex digits>`, derived from that home's real path, and never
sees your live secrets. The Jira and notification settings print the exact `security` command for
the install you are looking at. `FRM_SECRET_<NAME>` in a process's environment is read first
everywhere. **Linux** works the same way, except secrets come from files: set
`FRM_SECRET_STORE=file` and put each secret in its own read-only file under `FRM_SECRETS_DIR` (default
`/run/secrets`). A Docker Compose server deploy with an operator login lives in `deploy/`.
**Windows** isn't supported natively, because process-group signals, tmux and POSIX
shell are all load-bearing. WSL2 behaves like Linux.

## Reference

### Secrets

Everything a runner needs comes from the host secret store into its environment at spawn. It's never
written to the database, a prompt, a log or a worktree.

| Name                      | What                                                                         | Needed for      |
| ------------------------- | ---------------------------------------------------------------------------- | --------------- |
| `FRM_API_TOKEN`           | The bearer token the GUI and `frm` use to reach the API                      | everything      |
| `CLAUDE_CODE_OAUTH_TOKEN` | From `claude setup-token`; or `ANTHROPIC_API_KEY` for a Console key          | `claude-sdk`    |
| `CODEX_API_KEY`           | An OpenAI API key                                                            | `codex-exec`    |
| `CODEX_AUTH_JSON`         | Alternatively, the `auth.json` that `codex login` writes, as compact JSON    | `codex-exec`    |
| `FRM_BACKUP_KEY`          | Created by `pnpm frm backup init-key`; only its id is printed                | nightly backups |
| `JIRA_API_TOKEN`          | An Atlassian API token, read by the API at each sync                         | the Jira mirror |
| `OLLAMA_BASE_URL`         | The Ollama server's OpenAI-compatible address, e.g. `http://<host>:11434/v1` | `opencode`      |
| `FORGE_TOKEN_GITHUB`      | A GitHub token that can push branches and open PRs; sent only to GitHub      | delivery        |
| `NOTIFY_NTFY_URL`         | An ntfy topic URL                                                            | notifications   |
| `NOTIFY_WEBHOOK_URL`      | A Slack or generic https webhook                                             | notifications   |
| `NOTIFY_SMTP_URL`         | An SMTP URL for email                                                        | notifications   |

Store every value on **one line**. `security` prints any value that contains a newline, or any other
byte it can't print, back as a bare run of hex digits, with nothing marking it as hex. Bayon decodes
that form when the result is text, and refuses the secret by name when it isn't.

A ChatGPT login isn't a static secret. The Codex CLI rotates it in `~/.codex/auth.json`, so a
Keychain copy slowly goes out of date. You can give Bayon the live file instead with
`runners.login_in_place` (see [Settings](#settings)); Bayon then reads it at spawn and writes the
refreshed login back, but only a login that session refreshed itself, so it never overwrites a refresh
your own CLI made in the meantime. With the grant set, the Keychain copy is optional: sessions and
certification both read the live file, and an unusable file is refused by name rather than quietly
falling back to a stale copy. Only a runner that can read a login in place (today, Codex) may be
granted one: a grant to any other is refused, by `frm settings set` and again at every spawn and
certification run, instead of starting its sessions with no credential.

### Settings

Most settings are in GUI → Settings, and every change is audited. A few security settings can only
be changed from the shell, never from the GUI or the REST API:

```bash
FRM_HOME=~/.foreman pnpm frm settings get [key]
FRM_HOME=~/.foreman pnpm frm settings set <key> <value> --yes
```

| Shell-only setting            | What it does                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `admission.require_certified` | Refuses any runner that hasn't passed conformance on its executor (default on).                         |
| `executors.untrusted_roles`   | Roles that must run on an untrusted (container) executor; `frm executor add --untrusted-roles` sets it. |
| `runners.login_in_place`      | `<runner-id>=<absolute path>`: use an operator's live login file. `none` revokes.                       |
| `projects.local_roots`        | Folders the GUI's New project form may take a repo path from (default none). `none` revokes.            |

`frm` isn't on your system path. Run it from the clone as `pnpm frm …`.

### Certification

Admission refuses a runner that hasn't passed the §15 conformance suite on the executor it would run
on. Run it with Bayon running:

```bash
export FRM_API_TOKEN=$(security find-generic-password -s foreman -a FRM_API_TOKEN -w)
pnpm frm runner conformance fixture
FRM_REAL_RUNNER=1 pnpm frm runner conformance claude-sdk
FRM_REAL_RUNNER=1 pnpm frm runner conformance codex-exec
```

Each prints its report path and verdict, and exits 0 only when the pair is certified. A few tests
read **N/A** when they don't apply to that runner. Certification lapses whenever a runner's version,
capabilities or image changes, or the suite itself changes (`SUITE_VERSION`), so run it again then.
The Runners page in the GUI shows the state and can start a run. `--compression` runs the suite with
context compression on (and its own test, 17): the certificate a project that compresses its
context needs, kept beside the normal one and lapsed on its own when the compression rules change.

### Configuring projects

`pnpm frm project add` creates everything one project needs. Start the supervisor once first: its
boot registers the runners that profiles and agents name.

```bash
pnpm frm project add app --repo git@github.com:<org>/<repo>.git --runner claude-sdk
```

This creates a repo (mirror path under `$FRM_HOME/mirrors`, cloned on first use), one workspace, a
build profile and a builder agent (`app-builder`). Unless you pass `--no-orchestrator`, it also
creates an orchestrate profile and an orchestrator agent (`app-orchestrator`, default pulse policy,
no mission; staff it with `POST /missions`). It refuses a name that already exists, and warns and
prints the certify command when the (runner, executor) pair isn't certified; `--executor` defaults
to `local`. `--dry-run` prints the rows it would write without touching any database. See
`pnpm frm --help` for every flag.

The GUI's **Projects → New project** does the same from a browser. It takes an https or ssh url, and a
folder on this machine only inside one you have allowed from a shell, since the page can be
reached from your network. A folder whose repo has submodules becomes one project, with each
submodule checked out inside it at the commit the folder pins; each must be checked out in the
folder already.

```bash
FRM_HOME=~/.foreman pnpm frm settings set projects.local_roots "$HOME/src" --yes
```

#### Agents and staffing

To add builders, reviewers or an orchestrator to a project, each on its own runner, use
`POST /projects/<project>/agents` with `{"kind": "builder", "runner_id": "<runner>"}` (or `reviewer`,
`orchestrator`). A project has at most one enabled orchestrator: a second is refused (409) until you
disable the first. An added orchestrator starts on the default pulse policy with no mission, and
pulses that project alone. `PATCH /agents/<id>` with `enabled` or `max_concurrency` retires or
resizes one. `POST /projects/<project>/pause` holds one project while
the rest keep running: nothing new starts in it and its orchestrator doesn't wake, while turns
already running finish. `POST /projects/<project>/resume` lets it go. `PATCH /projects/<project>`
with `{"staff_approval": true}` makes the project's orchestrator propose each assignment instead of
starting it: the proposal lands in the Inbox, and answering `approve` starts that agent while
`reject` turns it down. Your own staffing never waits for approval.

#### Model per step

`PATCH /projects/<project>` with `{"step_tiers": {"plan": "complex", "build": "standard", "review":
"complex"}}` picks the model tier each step of the project's work runs: `plan` is a builder's
`spike`, `build` its `build`, `build_complex` and `fix`, and `review` every gate's reviewer. `null`
inherits, as a project starts: the agent's profile decides. A role binding that sets its own
`model_tier` still wins over the project. A step's model is admitted like any other, so it must be
certified (and, to review a gate, gate-eligible): `GET /runners` lists it among the model's bound roles
as `<project> · <step> step`, so `frm runner conformance <runner>` certifies it by default. The IDE's
**Settings → Models** sets the three and shows the model each step will run, and says when it isn't.

#### Context compression

`PATCH /projects/<project>` with `{"context_compression": true}` turns context compression on for
the sessions the project starts from then on: their model calls go through a local proxy that
shortens large tool output (long logs, big JSON arrays) before the model sees it, keeping every error
line, and stores the whole output on disk for the agent to read. It applies where the runner
compresses (claude-sdk and opencode), on a local executor, and not to the orchestrator; other sessions
run as before, and a live session keeps what it started with. A compressed session is admitted only
on a certificate earned with compression on (`frm runner conformance <runner> --model <id>
--compression`). The IDE's **Settings → Context compression** has the switch, asks before turning it
on, and shows each step model's certificate or the command that earns it; a session's screen shows
what it saved, and the Spend tables a "saved (est.)" column. It pays off most on small-context
local models; on Claude, most of the bill is output and the fixed prompt, so it saves little.

#### History and per-project views

`GET /projects/<project>/timeline` is the project's history, newest first: audit rows, ticket
events, sessions, pulses, gates, findings, hand-offs and inbox requests, filtered by `kind`,
`agent`, `ticket`, `from`/`to` or `q`. `/timeline/export?format=jsonl` (or `csv`) downloads all of
it, and `GET /agents/<id>/sessions` lists an agent's sessions to replay. In the GUI, a project's
**Overview** shows its orchestrator and what each agent is doing, live, and its **Agents** view adds,
enables, disables or resizes one and replays its sessions. Its **Orchestrator** view adds an
orchestrator to a project that has none. Its **History** view is that timeline, filtered by kind
chips, agent, ticket, dates or text, kept in the URL so a filtered view can be shared, and exported
as JSONL or CSV with the same filters; a row opens its ticket, session or pulse. Its **Reviews**,
**Inbox** and **Spend** views are the fleet's Reviews, Inbox and Spend screens for that project
alone, and a ticket or session there opens as a tab.
`GET /fleet?project=<project>` keeps one project's live sessions;
`GET /inbox?kind=staff_approval&project=<project>` its open proposals. `GET /gates?project=`,
`GET /inbox?project=` and `GET /spend?group=…&project=` keep one project's gates, requests and
spend. A spend row belongs to its ticket's project, else its session's, else that session's
agent's.

#### Jira mirror

A project can mirror its Jira issues into its tickets, one way: Jira to Bayon. Give it a source when
you create it (GUI → New project → **Mirror tickets from Jira**: the site, the account's email and
the project key, which fills in the query; Advanced edits it), or later from the Jira strip above
its IDE's Tickets view, which also syncs now, shows the last sync, and turns the mirror off. Over
REST it's `PATCH /projects/<project>` with
`{"jira": {"url": "https://<site>.atlassian.net", "email": "<you>@<domain>", "jql": "project = ABC"}}`
(`"jira": null` turns it off). A mirrored ticket's card and header carry its issue key, linked to
the issue. Only a Jira Cloud site is accepted, since the token goes to that site.
Store the token once, and the API reads it at every sync, so there's nothing to restart. It's never
written anywhere else. On a Mac, copy the token first, then store it from the clipboard (`-U`
replaces one already stored) and check its length:

```bash
security add-generic-password -U -s foreman -a JIRA_API_TOKEN -w "$(pbpaste)"
security find-generic-password -s foreman -a JIRA_API_TOKEN -w | wc -c   # about 190, not 129
```

Don't type or paste it at `security`'s own prompt (`-w` with no value): the prompt cuts input to 128
characters, and an Atlassian API token is longer. Jira treats a wrong token as an anonymous visitor
who can see nothing, so a sync checks the login first and fails, saying so, rather than mirroring
no issues.

On the docker host, put it in the API's secrets, the value on stdin:
`sudo /srv/bayon/<deployment>/secrets.sh put <deployment> api JIRA_API_TOKEN`. `GET /jira` says
which store the API reads and whether the token is there, without ever returning it; the GUI shows
that host's command until the token is found, and never asks for the token itself.

Each To Do issue the query matches becomes a backlog ticket, updated from Jira while it's still in
`backlog` or `prioritized`. Once work starts on it, Bayon owns it. An unstarted ticket whose issue
moves on in Jira, disappears, or stops matching the query is parked with a note that says why.
Nothing is deleted. `POST /projects/<project>/jira/sync` syncs now. A timer also syncs every project
with a source, every 15 minutes by default (`jira.sync_interval_ms` in GUI → Settings; 0 turns the
timer off). Between those full syncs, a quick pass every minute (`jira.quick_interval_ms`; 0 turns it
off) reads only the issues changed since the last pass, so a Jira edit shows up within a minute or
so. It files and updates tickets but never parks one: only a full sync sees the whole query, so
parking waits for it. `GET /projects/<project>/jira` shows the source and the last full sync. Every
full sync shows up in the project's history, and so does a quick pass that changed a ticket.
Pausing a project doesn't stop the mirror, because it starts no agents.
A mirrored issue's text ends up in the prompts of the agents that work its ticket, so anyone who can
create or edit an issue your query matches can steer them. Scope the query to people you trust,
for example `project = ABC AND reporter in (<you>@<domain>)`.

#### Config files

For a multi-repo workspace, extra profiles, or a batch of agents in one go, write the config by hand:

```json
{
  "repos": [
    {
      "id": "app",
      "name": "app",
      "origin_url": "git@github.com:<org>/<repo>.git",
      "install_cmd": "pnpm i",
      "lint_cmd": "pnpm -w lint"
    }
  ],
  "workspaces": [{ "id": "ws-app", "name": "app", "kind": "single" }],
  "workspace_repos": [
    { "workspace_id": "ws-app", "repo_id": "app", "rel_path": "app" }
  ],
  "profiles": [
    {
      "id": "build",
      "name": "build",
      "runner_id": "claude-sdk",
      "model_tier": "standard"
    }
  ],
  "agents": [
    {
      "id": "builder-1",
      "name": "builder-1",
      "kind": "builder",
      "runner_id": "claude-sdk",
      "executor_id": "local",
      "profile_id": "build",
      "workspace_id": "ws-app"
    }
  ]
}
```

```bash
pnpm frm config apply bayon.json
```

It all goes in one transaction: a missing parent, a repeated id or an unknown column writes nothing,
and the error names the problem. Anything left out gets filled in: the repo's mirror path
(`$FRM_HOME/mirrors/<id>.git`, cloned on first use), and a profile's version and hash. Add an agent
of `kind: "orchestrator"` if you want the pulse to staff tickets on its own.

**`install_cmd` and `lint_cmd`** are what the `lint_check` gate runs on the commit a builder submits
for review, so a lint failure is caught with evidence instead of costing a review round. Both are
an **argv, run with no shell**: `pnpm -w lint`, not `eslint . && prettier --check .`. A compound
command belongs in a package script, named here; `frm config apply` refuses one that isn't, rather
than letting a gate discover it weeks later. A repo with no `lint_cmd` gets no lint gate. The gate is
off until an operator turns it on with `{"settings": {"gates.lint_check": true}}` in the same file,
exactly as `gates.parity_check` is turned on. Turning it on needs the lint checker's own rows, which
need a supervisor that has booted. A file that does both before the daemon's first boot is refused
and writes nothing, because a gate switched on with no checker seeded stalls every ticket in
`code_review`. Boot the daemon, then apply the same file again. The gate runs the repository's own
scripts, so for now it only runs where the branch was built on the `local` executor.

### Per-run limits

Each session runs under a run class (`spike`, `build`, `fix`, `review`, …) that caps its context,
turns, tool calls, wall-clock time and cost. It hands off at 75 % of its turns or 70 % of its
context. The seeded classes suit a real agent: spike is 150k tokens, 100 turns and $5; build is
300k, 300 turns and $15. To tune one, apply a `run_classes` row with `pnpm frm config apply
<file.json>`; rows are upserted by name. A context cap below the runner's own baseline is refused at
spawn.

### Container executors

Agents can run in containers on a Linux docker host reached over ssh. Set one up with the supervisor
**stopped**, because re-imaging under a running supervisor breaks its gateway:

```bash
ssh <user>@<docker-host> true     # once, so the host key is in ~/.ssh/known_hosts (never scanned)
pnpm frm executor add ctr-1 --host <docker-host> --user <user> \
  --identity-ref "file:$HOME/.ssh/id_ed25519" --remote-root /home/<user>/frm
pnpm frm executor image ctr-1     # builds the runner image and the egress gateway on the host
# start the supervisor again, then:
pnpm frm runner conformance fixture --executor ctr-1
```

The defaults are 2 slots, `trust=untrusted`, and egress limited to an allowlist. Every container,
image, network and volume Bayon creates carries the labels `frm.managed=1` and `frm.executor=<id>`,
and cleanup only ever removes labelled objects, so a host shared with other stacks is safe. See
`pnpm frm --help` for the flags (`--slots`, `--quota-gb`, `--min-free-pct`, `--egress-allow`, …).
`fixture`, `codex-exec` and `claude-sdk` all run in containers. To take an executor out of service,
use `pnpm frm executor disable <id>`; admission then refuses it.

### Checking a build

```bash
pnpm -w typecheck && pnpm -w lint && pnpm -w test    # the test suite takes several minutes
pnpm frm smoke                                       # end to end: fixture runner, no key, no network
pnpm frm smoke --m1 && pnpm frm smoke --m2 && pnpm frm smoke --m3 && pnpm frm smoke --m4
```

Each smoke test builds its own temporary home and removes it when it passes, so it never touches your
install. `pnpm frm smoke --hang` is **expected to fail** (exit 1): it proves that a run that never
ends gets caught. The test suite runs real processes, so a failure while the machine is heavily
loaded is worth running again on its own before you believe it.

### Day to day

| Task             | How                                                                                                   |
| ---------------- | ----------------------------------------------------------------------------------------------------- |
| Pause everything | Use the top bar's switch, or `pnpm frm pause` / `pnpm frm resume`. Turns in flight finish.            |
| Find a screen    | The sidebar, or ⌘K (Ctrl K): screens, projects, agents, and a ticket by `#45` or its key.             |
| Settings         | GUI → Settings for most; `pnpm frm settings` for the shell-only ones.                                 |
| Audit trail      | GUI → Audit.                                                                                          |
| Projects         | The sidebar's **Projects**; a project opens its own views in the sidebar, **All projects** goes back. |
| Backups          | Nightly at 03:00 UTC, encrypted, newest 14 kept, in `$FRM_HOME/backups`.                              |
| Back up now      | `pnpm frm backup`                                                                                     |
| Restore          | `pnpm frm restore <file> --to <db-path>`; refused while a supervisor holds the target.                |
| Logs             | `$FRM_HOME/logs/*.log`                                                                                |

### Troubleshooting

| Symptom                                       | Fix                                                                                             |
| --------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `command not found: frm`                      | Run it as `pnpm frm …` from the clone.                                                          |
| `fetch failed (is the API up?)`               | The API isn't running. Start it, then check `curl -s http://127.0.0.1:3010/api/v1/health`.      |
| The API exits with `migrations pending`       | Run `pnpm --filter @bayon/db migrate:up`, or start the supervisor first.                        |
| A spawn is refused as uncertified             | Certify that runner on that executor again ([Certification](#certification)).                   |
| Sessions stay queued with `disk`              | Free disk space, or lower `admission.disk_min_free_pct` in Settings.                            |
| Every `codex-exec` test fails `runner:failed` | The stored ChatGPT login is stale. Run `codex exec "hi"` to refresh it, then store it again.    |
| The GUI answers 401 from another machine      | Its address must be in `FRM_WEB_ORIGINS` exactly: `http://<ip>:5173`, no trailing slash.        |
| `frm pause` says the API didn't answer        | It falls back to writing `$FRM_DB` directly; the change is audited either way.                  |
| An executor shows unhealthy after re-imaging  | Restart the supervisor, which recreates the gateway.                                            |
| `model X not served by <host>`                | The provider dropped or renamed that model. Pull it again, or point the model at one it serves. |
| A runner update shows in Needs You            | A new SDK or CLI is out. Upgrading is a code change: bump the pin, rebuild, re-certify.         |

## License

[MIT](LICENSE)
