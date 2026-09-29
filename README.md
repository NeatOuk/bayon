# Bayon

Control plane for a fleet of coding agents (codename foreman). You give it tickets. It runs AI
coding agents against your repos (Claude through the Agent SDK, open models through OpenCode and
Ollama, and Codex) and keeps them honest: an agent can't pass a review without evidence, can't see
a secret it wasn't given, and can't spend past a budget you set.

A supervisor daemon owns the agent processes, SQLite is the system of record, a NestJS API serves
REST, WebSocket and an MCP server for the agents, and a React GUI sits on top.

The [Quick start](#quick-start) below gets you from a fresh Mac to a running GUI and a first ticket.
The rest of this README is the overview and the reference.

- Working on the code: read [CLAUDE.md](CLAUDE.md) first.

## Quick start

On macOS. Copy the commands top to bottom.

### 1. Prerequisites

- **macOS.** Linux works too, with a different secret store (see [Platforms](#platforms)).
- **Node 22.13 or newer** (`node -v`).
- **pnpm 11.26**, the version in `package.json`. Run `corepack enable` once and Node provides it.
- **git** and the **Xcode command-line tools** (`xcode-select --install`): two dependencies compile
  native code.
- **tmux** (`brew install tmux`), to watch or take over an agent's terminal.
- **For real agents, a Claude login:** a subscription is enough (`claude setup-token` makes a token).
  The free `fixture` runner needs no login, and is enough to try everything below.

### 2. Install and build

```bash
git clone <repo-url> bayon
cd bayon
corepack enable
pnpm i
pnpm -w build
```

Every command below runs from this folder.

### 3. One-time setup

```bash
pnpm frm init
```

This creates the install's home, `~/.foreman`, stores a new API token in the Keychain (it's never
printed), and writes the install's ports to `~/.foreman/install.json`: 3010 for the API and 5173 for
the GUI. Running it again changes nothing. `frm` uses `~/.foreman` unless `FRM_HOME` says otherwise.

For real Claude agents, store your login once. Copy the token `claude setup-token` prints, then paste
it at the prompt:

```bash
claude setup-token
security add-generic-password -s foreman -a CLAUDE_CODE_OAUTH_TOKEN -w
```

Optional: `pnpm frm backup init-key` turns on nightly encrypted backups.

### 4. Start

```bash
pnpm start
```

This runs the database migrations, then starts the supervisor, the API and the GUI, and prints:

```
home    ~/.foreman
GUI     http://localhost:5173
logs    ~/.foreman/logs/{supervisor,api,web}.log
Ctrl-C stops all three
```

If you'd rather run each process in its own terminal, start them in this order, from the clone (the
API refuses to start until the supervisor has migrated the database). Each needs `FRM_HOME` set; none
needs the token, which each reads from the Keychain. Their logs then go to their terminals:

```bash
FRM_HOME=~/.foreman pnpm --filter @bayon/supervisor start   # terminal 1
FRM_HOME=~/.foreman pnpm --filter @bayon/api start          # terminal 2
FRM_HOME=~/.foreman pnpm --filter @bayon/web dev            # terminal 3
```

### 5. Open the GUI

Open <http://localhost:5173>. The **Fleet** page opens with **Needs you**, a checklist of what stands
between you and a working install (a project first, then an uncertified runner, a missing builder or
mission). Each item links to its fix. The next step clears them.

### 6. Your first project and ticket

1. **Create a project.** **Projects → New project**. Give it a git url (https or ssh), or a folder on
   this Mac. For a folder, when you're in a browser on this Mac at `localhost`, the form offers
   **Allow agents to use this folder**, and **Initialise this folder as a git repository** when the
   folder is empty or has no commits. From a terminal, `pnpm frm roots add <folder> --yes` allows a
   folder instead. Pick a **Runner** (`fixture` to try things out). The project gets a builder, a
   reviewer and an orchestrator.
2. **Certify its runner.** Bayon gives no work to a runner that hasn't passed its conformance suite.
   On **Runners**, run conformance for the project's runner, or from a terminal:

   ```bash
   pnpm frm runner conformance fixture      # free, about a minute
   pnpm frm runner conformance claude-sdk   # about $0.20 on your Claude login
   ```

   It certifies every model the project's agents use. `fixture` is a test script that does no real
   work: its session goes idle after one turn, which is its expected end. Use a real runner for real
   work.

3. **File a ticket.** **Tickets → New ticket**, with your project picked under **Project**. It starts
   in Backlog.
4. **Start work.** The ticket page's next-step line offers **Start work** when a builder can take the
   ticket. It prioritises the ticket and staffs the builder, each checked by the same rules as doing
   it by hand. The line then reads "Starting a session for …" until the session is up, then shows
   who holds the ticket and what it's doing.

The orchestrator has no mission until you write one, in the project's **Orchestrator** tab. It can
staff tickets without one, but a mission is how you tell it what matters.

### 7. Stop, and find the logs

Press **Ctrl-C** in the terminal running `pnpm start`. It stops the GUI, then the API, then the
supervisor, waiting for each; the supervisor may take up to a minute if it is finishing a backup,
and says so. Closing that terminal stops them the same way. Running agents are left alone, and the
supervisor picks them up again the next time it starts, so no work is lost. To keep Bayon running
after you close the terminal, run `pnpm start` inside tmux.

Logs are in `~/.foreman/logs/`: `supervisor.log`, `api.log` and `web.log`, each started fresh by
`pnpm start` with the previous run's kept as `.log.1`. If one process stops by itself, `pnpm start`
stops the other two and prints the end of that process's log. `pnpm start` refuses to start on a
home that is already running.

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
  ticket work itself. A pulse with nothing to act on is skipped at no cost, and a ticket still in
  Backlog isn't something to act on: prioritise it, or use **Start work**, to put it in front of the
  orchestrator.
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
| `FRM_API_TOKEN`           | The API's bearer; `pnpm frm init` creates it in this home's store, unprinted | everything      |
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
pnpm frm settings get [key]
pnpm frm settings set <key> <value> --yes
```

`frm` uses `~/.foreman` unless `FRM_HOME` or `FRM_DB` says otherwise, and says so on stderr
(`(using ~/.foreman)`). A mistyped command or option names the closest one; `pnpm frm <command>
--help` shows that command's usage. If `frm` says its build is out of date, run `pnpm -w build`.

| Shell-only setting            | What it does                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------- |
| `admission.require_certified` | Refuses any runner that hasn't passed conformance on its executor (default on).                         |
| `executors.untrusted_roles`   | Roles that must run on an untrusted (container) executor; `frm executor add --untrusted-roles` sets it. |
| `runners.login_in_place`      | `<runner-id>=<absolute path>`: use an operator's live login file. `none` revokes.                       |
| `projects.local_roots`        | Folders the GUI's New project form may take a repo path from (default none). Use `frm roots` below.     |

`frm` isn't on your system path. Run it from the clone as `pnpm frm …`.

### Certification

A session doesn't start on a runner that hasn't passed the conformance suite on the executor it would
run on. Run it with Bayon running, with `FRM_HOME` set to the install to certify: `frm` reaches that
home's own API with that home's own token, never another install's.

```bash
pnpm frm runner conformance fixture
pnpm frm runner conformance claude-sdk
pnpm frm runner conformance codex-exec
```

A certificate holds for one model. With no `--model`, each command certifies every model of that
runner that something uses: a project's agents, a project's step tiers or a role binding. It names
each model and who uses it. On a runner that nothing uses yet, it certifies the runner's default
(standard tier) model. `--model <id>` certifies just that one. Each run prints its report path and
verdict, and the command exits 0 only when every model it ran is certified. A few tests read
**N/A** when they don't apply to that runner. Certification lapses whenever a runner's version,
capabilities or image changes, or the suite itself changes in an upgrade, so run it again then.
The Runners page in the GUI shows the state and can start a run. It picks the model in use first,
and says who uses it. When more than one model is in use, one button certifies them all. Bayon's
own job runners (the exporter and the script checks) aren't agents, so they're never offered for
certification. `--compression` runs the suite with
context compression on (and its own test, 17): the certificate a project that compresses its
context needs, kept beside the normal one and lapsed on its own when the compression rules change.

### Configuring projects

`pnpm frm project add` creates everything one project needs. Start Bayon once first: the supervisor's
boot registers the runners that profiles and agents name.

```bash
pnpm frm project add app --repo git@github.com:<org>/<repo>.git --runner claude-sdk
```

This creates a repo (mirror path under `$FRM_HOME/mirrors`, cloned on first use), one workspace, a
build profile and a builder agent (`app-builder`). Unless you pass `--no-orchestrator`, it also
creates an orchestrate profile and an orchestrator agent (`app-orchestrator`, default pulse policy,
no mission; write one in the project's Orchestrator tab, or with `POST /missions`). It refuses a name that already exists, and warns and
prints the certify command when the (runner, executor) pair isn't certified; `--executor` defaults
to `local`. `--dry-run` prints the rows it would write without touching any database. See
`pnpm frm --help` for every flag.

The GUI's **Projects → New project** does the same from a browser. It takes an https or ssh url, or a
folder on this machine inside one you have allowed. The form checks a folder before it creates
anything. In a browser on this machine, opened at `localhost`, a folder not allowed yet comes with
**Allow agents to use this folder** (it adds the folder, or its parent, to the list and writes the
change to the audit log). From any other machine the form shows the command to run here instead,
since the page can be reached from your network. A folder that is empty or has no commits yet is
offered **Initialise this folder as a git repository**: `git init` and one empty first commit, with
none of your files added. A folder whose repo has submodules becomes one project, with each
submodule checked out inside it at the commit the folder pins; each must be checked out in the
folder already.

```bash
pnpm frm roots add "$HOME/src" --yes     # allow one more folder; the others stay
pnpm frm roots list
pnpm frm roots remove "$HOME/src" --yes
```

`roots add` stores the folder's real path and refuses one that doesn't exist or isn't a directory;
adding it twice changes nothing. Each change is audited, like `frm settings set`. `frm settings set
projects.local_roots <a,b,…> --yes` still replaces the whole list at once.

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

### A second install

Everything an install needs follows from its `FRM_HOME`, so a second one (a scratch copy, a trial of
a new build) runs beside the first without touching it:

```bash
export FRM_HOME=~/bayon-scratch
pnpm frm init     # its own token and ports
pnpm start        # its supervisor, API and GUI, on those ports
```

`frm init` stores a new API token under that home's own Keychain service (never printed) and
writes the home's ports to `$FRM_HOME/install.json`: the default home keeps 3010 and 5173, any other
takes the first free pair after them (`--api-port` and `--web-port` choose). The API, the GUI, the
supervisor's sessions and `frm` all read them from there; `FRM_API_HOST`, `FRM_API_PORT`,
`FRM_WEB_PORT`, `FRM_API_URL` and `FRM_MCP_URL` still override. The file may bind the API to
`127.0.0.1`, `::1` or `localhost` only (`0.0.0.0` or `::` with `"expose": true`); any other address
comes from `FRM_API_HOST`. The stored token is read only when `FRM_HOME` (or `FRM_DB`) names the
install, and never inside an agent's session. The GUI refuses to start when its port is taken,
rather than quietly sharing it. A home whose path is too long for a unix socket (104 bytes) keeps
its sockets in a private `frm-<hash>` folder in your account's temp directory instead.

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

| Task             | How                                                                                                                                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Pause everything | Use the top bar's switch, or `pnpm frm pause` / `pnpm frm resume`. Turns in flight finish.                                                   |
| Find a screen    | The sidebar, or ⌘K (Ctrl K): screens, projects, agents, and a ticket by `#45` or its key.                                                    |
| Settings         | GUI → Settings for most; `pnpm frm settings` for the shell-only ones.                                                                        |
| Audit trail      | GUI → Audit.                                                                                                                                 |
| Projects         | The sidebar's **Projects**; a project opens its own views in the sidebar, **All projects** goes back.                                        |
| Backups          | Nightly at 03:00 UTC, encrypted, newest 14 kept, in `$FRM_HOME/backups`; off until `frm backup init-key`.                                    |
| Back up now      | `pnpm frm backup`                                                                                                                            |
| Restore          | `pnpm frm restore <file> --to <db-path>`; refused while a supervisor holds the target.                                                       |
| Logs             | `$FRM_HOME/logs/*.log`. At a terminal the supervisor prints short lines, warnings up; `FRM_LOG_FORMAT=json` and `FRM_LOG_LEVEL` change that. |

### Troubleshooting

| Symptom                                            | Fix                                                                                                       |
| -------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `command not found: frm`                           | Run it as `pnpm frm …` from the clone.                                                                    |
| `this frm build is out of date`                    | The sources changed since the last build. Run `pnpm -w build`.                                            |
| `fetch failed (is the API up?)`                    | The API isn't running. Run `pnpm start`, then check `curl -s http://127.0.0.1:3010/api/v1/health`.        |
| The API exits with `The database needs an upgrade` | Use `pnpm start`, which migrates first; or start the supervisor before the API.                           |
| A spawn is refused as uncertified                  | Certify that runner on that executor again ([Certification](#certification)).                             |
| Sessions stay queued with `disk`                   | Free disk space, or lower `admission.disk_min_free_pct` in Settings.                                      |
| Every `codex-exec` test fails `runner:failed`      | The stored ChatGPT login is stale. Run `codex exec "hi"` to refresh it, then store it again.              |
| `the GUI's port 5173 is already taken`             | Another install (or server) holds it. Stop it, or give this home its own: `pnpm frm init --web-port <n>`. |
| `FRM_API_TOKEN is required`                        | Run `pnpm frm init` for this `FRM_HOME`: it stores a token in the home's own Keychain service.            |
| The GUI answers 401 from another machine           | Its address must be in `FRM_WEB_ORIGINS` exactly: `http://<ip>:5173`, no trailing slash.                  |
| `frm pause` says the API didn't answer             | It falls back to writing `$FRM_DB` directly; the change is audited either way.                            |
| An executor shows unhealthy after re-imaging       | Restart the supervisor, which recreates the gateway.                                                      |
| `model X not served by <host>`                     | The provider dropped or renamed that model. Pull it again, or point the model at one it serves.           |
| A runner update shows in Needs You                 | A new SDK or CLI is out. Upgrading is a code change: bump the pin, rebuild, re-certify.                   |

## License

[MIT](LICENSE)
