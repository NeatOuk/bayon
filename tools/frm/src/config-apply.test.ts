import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@bayon/core";
import {
  getAgent,
  getProfile,
  getSettings,
  getWorkspace,
  listRepos,
  listRunClasses,
} from "@bayon/db";
import {
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import { CATALOGUE_TOOLS, toolsetFor, workRoleTools } from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { parseCli } from "./cli.js";
import { runConfigCommand } from "./config-apply.js";
import { LINT } from "./lint-config.js";
import { QA } from "./qa-config.js";
import { PARITY } from "./parity-config.js";

const dir = mkdtempSync(join(tmpdir(), "frm-config-"));
const cleanups: (() => void)[] = [];
let t: TempDb;
beforeAll(async () => {
  t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  // The runner and executor rows profiles and agents point at, as a booted supervisor leaves them.
  unwrap(await seedSpine(t.db, 1));
});
afterAll(() => {
  for (const cleanup of cleanups) cleanup();
  t.cleanup();
  rmSync(dir, { recursive: true, force: true });
});

async function apply(name: string, body: unknown, db: TempDb = t) {
  const file = join(dir, `${name}.json`);
  writeFileSync(file, typeof body === "string" ? body : JSON.stringify(body));
  const out: string[] = [];
  const errs: string[] = [];
  const code = await runConfigCommand(
    { action: "apply", file, yes: false },
    {
      env: { FRM_HOME: dir, FRM_DB: db.path },
      out: (l) => out.push(l),
      err: (l) => errs.push(l),
    },
  );
  return { code, out: out.join("\n"), err: errs.join("\n") };
}

const repoIds = async (): Promise<string[]> =>
  unwrap(await listRepos(t.db)).map((r) => r.id);

const FIRST = {
  repos: [
    {
      id: "app",
      name: "app",
      origin_url: "https://example.com/app.git",
      doctrine_paths_json: ["DOCTRINE.md"],
    },
  ],
  workspaces: [{ id: "ws-app", name: "app", kind: "single" }],
  workspace_repos: [
    { workspace_id: "ws-app", repo_id: "app", rel_path: "app" },
  ],
  profiles: [
    {
      id: "build",
      name: "build",
      runner_id: "fixture",
      model_tier: "standard",
    },
  ],
  agents: [
    {
      id: "builder-1",
      name: "builder-1",
      kind: "builder",
      runner_id: "fixture",
      executor_id: "local",
      profile_id: "build",
      workspace_id: "ws-app",
    },
  ],
};

test("parseCli: frm config apply <file>", () => {
  expect(parseCli(["config", "apply", "x.json"])).toMatchObject({
    ok: true,
    value: { command: "config" },
  });
  expect(parseCli(["config", "apply"]).ok).toBe(false);
  expect(parseCli(["config", "apply", "a", "b"]).ok).toBe(false);
  expect(parseCli(["config", "apply", "x.json", "--yes"])).toMatchObject({
    ok: true,
    value: { command: "config", options: { action: "apply", yes: true } },
  });
  expect(parseCli(["config", "apply", "--yes"]).ok).toBe(false);
  expect(parseCli(["models", "list"])).toMatchObject({
    ok: true,
    value: { options: { action: "models" } },
  });
  expect(parseCli(["models", "list", "r1"])).toMatchObject({
    ok: true,
    value: { options: { action: "models", runner: "r1" } },
  });
  expect(parseCli(["models", "add"]).ok).toBe(false);
  expect(parseCli(["models", "list", "a", "b"]).ok).toBe(false);
});

test("a valid file seeds its rows, with the defaults filled in", async () => {
  const r = await apply("first", FIRST);
  expect(r.code).toBe(0);
  // Both script jobs' runners are registered by the supervisor at its boot, and this database has
  // never had one: the apply the operator asked for still lands, and says what it skipped and why
  //. A skip is a warning, so it also reaches stderr -- appended to the
  // success line alone it was invisible to anything reading the streams apart (review HIGH).
  expect(r.err.split("\n")).toEqual([
    `frm config apply: warning: the parity checker was not seeded (no runner ${PARITY.runnerId}): apply again once the supervisor has booted`,
    `frm config apply: warning: the lint checker was not seeded (no runner ${LINT.runnerId}): apply again once the supervisor has booted`,
    `frm config apply: warning: the QA checker was not seeded (no runner ${QA.runnerId}): apply again once the supervisor has booted`,
  ]);
  expect(r.out).toBe(
    "applied: 1 repos, 1 workspaces, 1 workspace_repos, 1 profiles, 1 agents" +
      `; the parity checker was not seeded (no runner ${PARITY.runnerId}): apply again once the supervisor has booted` +
      `; the lint checker was not seeded (no runner ${LINT.runnerId}): apply again once the supervisor has booted` +
      `; the QA checker was not seeded (no runner ${QA.runnerId}): apply again once the supervisor has booted`,
  );
  expect((await getAgent(t.db, PARITY.agentId)).ok).toBe(false);
  const repo = unwrap(await listRepos(t.db)).find((x) => x.id === "app");
  expect(repo).toMatchObject({
    mirror_path: join(dir, "mirrors", "app.git"),
    doctrine_paths_json: '["DOCTRINE.md"]',
  });
  expect(unwrap(await getProfile(t.db, "build"))).toMatchObject({
    version: 1,
    hash: expect.any(String),
  });
  expect(unwrap(await getAgent(t.db, "builder-1"))).toMatchObject({
    profile_id: "build",
    workspace_id: "ws-app",
  });
  expect(unwrap(await getWorkspace(t.db, "ws-app"))).toMatchObject({
    kind: "single",
  });
});

const allowlistOf = async (id: string): Promise<string[]> =>
  z
    .array(z.string())
    .parse(JSON.parse(unwrap(await getProfile(t.db, id)).tool_allowlist_json));

test("a profile that names no tools gets the whole catalogue, so its role's row decides", async () => {
  // FIRST's `build` profile names none.
  const allowlist = await allowlistOf("build");
  expect(allowlist).toEqual(CATALOGUE_TOOLS);
  for (const role of ["builder", "reviewer", "investigator", "orchestrator"]) {
    const served = toolsetFor(role, allowlist);
    expect(served.ok && served.value.map((x) => x.wire), role).toEqual(
      workRoleTools(role).map((x) => x.wire),
    );
  }
  // The hash covers the filled-in allowlist: the same profile naming every tool hashes the same.
  const r = await apply("explicit-all", {
    profiles: [
      {
        ...FIRST.profiles[0],
        id: "all",
        name: "all",
        tool_allowlist_json: CATALOGUE_TOOLS,
      },
    ],
  });
  expect(r.code).toBe(0);
  expect(unwrap(await getProfile(t.db, "all")).hash).toBe(
    unwrap(await getProfile(t.db, "build")).hash,
  );
});

test("an allowlist the file gives is kept as given, [] included", async () => {
  const r = await apply("narrow", {
    profiles: [
      {
        ...FIRST.profiles[0],
        id: "narrow",
        name: "narrow",
        tool_allowlist_json: ["ticket_get"],
      },
      {
        ...FIRST.profiles[0],
        id: "none",
        name: "none",
        tool_allowlist_json: [],
      },
    ],
  });
  expect(r.code).toBe(0);
  expect(await allowlistOf("narrow")).toEqual(["ticket_get"]);
  expect(await allowlistOf("none")).toEqual([]);
});

test("a missing parent writes nothing, not even the rows before it", async () => {
  const r = await apply("orphan", {
    repos: [{ id: "lib", name: "lib" }],
    agents: [
      { id: "a2", name: "a2", kind: "builder", runner_id: "no-such-runner" },
    ],
  });
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/nothing written/);
  expect(await repoIds()).not.toContain("lib");
});

test("an unknown table or column is refused by name; nothing is written", async () => {
  const table = await apply("table", { repo: [] });
  expect(table.code).toBe(2);
  expect(table.err).toMatch(/repo/);
  const column = await apply("column", {
    repos: [{ id: "lib2", name: "lib2", colour: "red" }],
  });
  expect(column.code).toBe(1);
  expect(column.err).toMatch(/colour/);
  expect(await repoIds()).not.toContain("lib2");
});

test("a repeated id is refused", async () => {
  const r = await apply("again", { repos: FIRST.repos });
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/nothing written/);
});

test("agents.mission_id is refused: only the API sets an agent's mission", async () => {
  const r = await apply("mission", {
    agents: [{ ...FIRST.agents[0], id: "a3", name: "a3", mission_id: "m-1" }],
  });
  expect(r.code).toBe(2);
  expect(r.err).toMatch(/mission_id is set by the API/);
  expect((await getAgent(t.db, "a3")).ok).toBe(false);
});

test("a seeded untrusted role that is no role is refused; nothing is written", async () => {
  // The third door: this one has no --yes prompt and had no role check either,
  // so the reviewer's file applied with exit 0 and stored strings trustRefusal can never match —
  // `frm settings get` showing a plausible list with the isolation boundary off. Core's schema
  // refuses it here as at the other two doors, and the refusal writes nothing at all.
  const r = await apply("roles", {
    settings: {
      "executors.untrusted_roles": ["reviewr", "REVIEWER", " builder "],
      "admission.require_certified": 0,
    },
  });
  expect(r.code).toBe(1);
  expect(r.err).toMatch(/executors\.untrusted_roles/);
  const rows = unwrap(
    await getSettings(t.db, [
      "executors.untrusted_roles",
      "admission.require_certified",
    ]),
  );
  expect(rows.get("executors.untrusted_roles")).toEqual(["investigator"]);
  expect(rows.get("admission.require_certified")).toBe(1);
});

// review LOW: `lintArgv` ran only at job time, so this applied with exit 0 and the operator found
// out when a gate first opened -- as a reviewer_error on somebody's ticket. The rule is pure and
// already in core; the repo's convention is fail-fast at boundaries, and this is a boundary.
test("a lint_cmd that is not an argv is refused here, not when a gate first opens", async () => {
  const r = await apply("compound", {
    repos: [
      {
        id: "cmpd",
        name: "cmpd",
        lint_cmd: "eslint . && prettier --check .",
      },
    ],
  });
  expect(r.code).toBe(2);
  expect(r.err).toContain("repos.lint_cmd");
  expect(r.err).toContain("is not an argv");
  expect(await repoIds()).not.toContain("cmpd");
});

test("install_cmd is held to the same rule, and named as itself", async () => {
  const r = await apply("compound-install", {
    repos: [{ id: "cmpd2", name: "cmpd2", install_cmd: "pnpm i || true" }],
  });
  expect(r.code).toBe(2);
  expect(r.err).toContain("repos.install_cmd");
  expect(await repoIds()).not.toContain("cmpd2");
});

test("a repo that declares no command is left alone: no lint_cmd opens no gate", async () => {
  const r = await apply("no-cmd", {
    repos: [{ id: "plain", name: "plain", lint_cmd: "" }],
  });
  expect(r.code).toBe(0);
  expect(await repoIds()).toContain("plain");
});

// An empty object asked for nothing, and the line said so: `applied: ; seeded the parity checker`.
test("an empty file says it applied nothing, not nothing at all", async () => {
  const r = await apply("empty", {});
  expect(r.code).toBe(0);
  expect(r.out.startsWith("applied: nothing")).toBe(true);
});

test("a file that is not JSON is refused before the database opens", async () => {
  const r = await apply("bad", "{");
  expect(r.code).toBe(2);
  expect(r.err).toMatch(/bad\.json/);
});

// nothing but the M3 smoke ever seeded the parity checker's rows, so a real deployment
// had no kind='util' agent of the parity job and chooseParityJob answered `no_reviewer` the moment
// an operator turned `gates.parity_check` on — a required gate nobody could decide.
describe("the parity checker rides along with the operator's own rows", () => {
  /** A database as a booted supervisor leaves it: the parity runner registered, `local` present. */
  async function booted() {
    const db = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
    cleanups.push(db.cleanup);
    unwrap(await seedSpine(db.db, 1));
    unwrap(
      await seedRows(db.db, {
        runners: [PARITY.runnerId, LINT.runnerId, QA.runnerId].map((id) => ({
          id,
          kind: "script",
          adapter: id,
          caps_json: "{}",
        })),
      }),
    );
    return db;
  }

  const applyTo = (db: TempDb, name: string, body: unknown) =>
    apply(name, body, db);

  test("seeded once the runner exists: the run class, the profile and a kind='util' agent", async () => {
    const db = await booted();
    const r = await applyTo(db, "parity-first", { repos: [] });
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(r.out).toContain(`seeded the parity checker (${PARITY.agentId})`);
    expect(unwrap(await getAgent(db.db, PARITY.agentId))).toMatchObject({
      kind: "util",
      runner_id: PARITY.runnerId,
      executor_id: PARITY.executor,
      profile_id: PARITY.agentId,
      workspace_id: null,
    });
    expect(unwrap(await getProfile(db.db, PARITY.agentId))).toMatchObject({
      runner_id: PARITY.runnerId,
      tool_allowlist_json: "[]",
    });
    expect(unwrap(await listRunClasses(db.db)).map((c) => c.name)).toContain(
      PARITY.runClass,
    );
  });

  // and so does the QA checker, whose gate is switched on per project rather than by a
  // fleet setting — which is why no file can be refused for turning it on (`setting: null`).
  test("the QA checker is seeded beside them, kind='util' on local", async () => {
    const db = await booted();
    const r = await applyTo(db, "qa-first", { repos: [] });
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(r.out).toContain(`seeded the QA checker (${QA.agentId})`);
    expect(unwrap(await getAgent(db.db, QA.agentId))).toMatchObject({
      kind: "util",
      runner_id: QA.runnerId,
      executor_id: QA.executor,
      profile_id: QA.agentId,
      workspace_id: null,
    });
    expect(unwrap(await getProfile(db.db, QA.agentId))).toMatchObject({
      runner_id: QA.runnerId,
      tool_allowlist_json: "[]",
    });
    // Its run class is 002's own `qa`, not a row this seeds: a second one of that name would be a
    // UNIQUE conflict, and the operator's whole apply would be lost to it.
    expect(unwrap(await listRunClasses(db.db)).map((c) => c.name)).toContain(
      QA.runClass,
    );
  });

  // the lint checker rides along the same way, in the same transaction.
  test("the lint checker is seeded beside it, kind='util' on local", async () => {
    const db = await booted();
    const r = await applyTo(db, "lint-first", { repos: [] });
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(r.out).toContain(`seeded the lint checker (${LINT.agentId})`);
    expect(unwrap(await getAgent(db.db, LINT.agentId))).toMatchObject({
      kind: "util",
      runner_id: LINT.runnerId,
      executor_id: LINT.executor,
      profile_id: LINT.agentId,
      workspace_id: null,
    });
    expect(unwrap(await getProfile(db.db, LINT.agentId))).toMatchObject({
      runner_id: LINT.runnerId,
      tool_allowlist_json: "[]",
    });
    expect(unwrap(await listRunClasses(db.db)).map((c) => c.name)).toContain(
      LINT.runClass,
    );
  });

  // Each job is judged on its own: the parity runner exists here and the lint one does not, so one
  // is seeded and the other is skipped with a line saying why — never both lost together.
  test("a job whose runner is missing is skipped alone, and named", async () => {
    const db = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
    cleanups.push(db.cleanup);
    unwrap(await seedSpine(db.db, 1));
    unwrap(
      await seedRows(db.db, {
        runners: [
          {
            id: PARITY.runnerId,
            kind: "script",
            adapter: PARITY.runnerId,
            caps_json: "{}",
          },
        ],
      }),
    );
    const r = await applyTo(db, "lint-absent", { repos: [] });
    expect(r.code).toBe(0);
    expect(r.err).toContain(`warning: the lint checker was not seeded`);
    expect(r.out).toContain(`seeded the parity checker (${PARITY.agentId})`);
    expect(r.out).toContain(
      `the lint checker was not seeded (no runner ${LINT.runnerId})`,
    );
  });

  // seedConfig inserts profiles and agents plainly, so a second apply that re-sent them would
  // conflict on the id and write NOTHING — the operator's whole file lost to a row they never asked
  // for. This is the test that keeps `config apply` runnable twice.
  test("a second apply seeds it again no more, and still applies the file", async () => {
    const db = await booted();
    expect((await applyTo(db, "parity-a", { repos: [] })).code).toBe(0);
    const again = await applyTo(db, "parity-b", {
      repos: [{ id: "lib", name: "lib" }],
    });
    expect(again).toMatchObject({ code: 0, err: "" });
    expect(again.out).toBe("applied: 1 repos");
    expect(unwrap(await listRepos(db.db)).map((x) => x.id)).toContain("lib");
  });

  // review HIGH: `jobPlan` skipped the job's rows when the runner was absent -- which the file
  // itself calls normal, "applying a config file before the daemon's first boot" -- while
  // `seedConfig` wrote the file's `settings` in the same transaction. One file carrying
  // repos.lint_cmd and {"gates.lint_check": true} therefore left the switch on with no kind='util'
  // agent, at exit 0: `chooseLintJob` answers `no_reviewer` on every round and every ticket stops
  // in code_review, decidable only by waiving. Off is the safe state the whole design rests on, so
  // the one file that can invert it writes nothing at all.
  test("a file that turns a gate on while its checker cannot be seeded is refused, and writes nothing", async () => {
    const db = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
    cleanups.push(db.cleanup);
    unwrap(await seedSpine(db.db, 1));
    const r = await applyTo(db, "lint-on-unseeded", {
      repos: [
        {
          id: "app2",
          name: "app2",
          lint_cmd: "pnpm -w lint",
        },
      ],
      settings: { "gates.lint_check": true },
    });
    expect(r.code).toBe(1);
    expect(r.out).toBe("");
    expect(r.err).toContain("nothing written");
    expect(r.err).toContain("gates.lint_check is on in this file");
    expect(r.err).toContain("no_reviewer");
    // Nothing at all: not the repo, and above all not the switch.
    expect(unwrap(await listRepos(db.db)).map((x) => x.id)).not.toContain(
      "app2",
    );
    expect(
      unwrap(await getSettings(db.db, ["gates.lint_check"])).get(
        "gates.lint_check",
      ),
    ).toBe(false);
  });

  // Turning it on once the rows can be seeded is the normal path, and still works.
  test("the same file applies once the supervisor has booted", async () => {
    const db = await booted();
    const r = await applyTo(db, "lint-on-booted", {
      settings: { "gates.lint_check": true },
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain(`seeded the lint checker (${LINT.agentId})`);
    expect(
      unwrap(await getSettings(db.db, ["gates.lint_check"])).get(
        "gates.lint_check",
      ),
    ).toBe(true);
    expect(unwrap(await getAgent(db.db, LINT.agentId)).kind).toBe("util");
  });

  // A switch already on in the database is a fleet that is already stalling; refusing every later
  // apply would take away the command that fixes it.
  test("a switch the file does not name is not this command's to refuse", async () => {
    const db = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
    cleanups.push(db.cleanup);
    unwrap(await seedSpine(db.db, 1));
    expect(
      (
        await applyTo(db, "on-first", {
          settings: { "gates.lint_check": true },
        })
      ).code,
    ).toBe(1);
    // ...and with the switch left off, a file that says nothing about it still applies.
    const r = await applyTo(db, "quiet", { repos: [{ id: "q", name: "q" }] });
    expect(r.code).toBe(0);
    expect(unwrap(await listRepos(db.db)).map((x) => x.id)).toContain("q");
  });

  // review MEDIUM-HIGH: the "only when the agent is absent" guard read the DATABASE only. An
  // operator re-applying an exported file, or declaring the util agent themselves, had the shipped
  // row appended beside their own -- one insertInto("agents") with the same primary key twice, a
  // `conflict`, exit 1 and nothing written. That is the very failure the guard exists to prevent;
  // it prevented it only on the second apply.
  test("a file that declares the checker's own agent keeps it, and the apply lands", async () => {
    const db = await booted();
    const r = await applyTo(db, "own-lint-agent", {
      profiles: [
        {
          id: LINT.agentId,
          name: "ours",
          runner_id: LINT.runnerId,
          model_tier: "cheap",
        },
      ],
      agents: [
        {
          id: LINT.agentId,
          name: "ours",
          kind: "util",
          runner_id: LINT.runnerId,
          executor_id: LINT.executor,
          profile_id: LINT.agentId,
        },
      ],
    });
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(r.out).not.toContain("seeded the lint checker");
    expect(unwrap(await getAgent(db.db, LINT.agentId)).name).toBe("ours");
    // The parity checker beside it is untouched by the collision that never happened.
    expect(r.out).toContain(`seeded the parity checker (${PARITY.agentId})`);
  });

  // review MEDIUM: `merged` appended the shipped rows LAST and run_classes is an upsert, so an
  // operator's own row was overwritten by the shipped default in the same command that wrote it.
  // §4: config is the operator's.
  test("an operator's own run class is not overwritten by the shipped default", async () => {
    const db = await booted();
    const r = await applyTo(db, "own-run-class", {
      run_classes: [
        {
          name: LINT.runClass,
          context_tokens_cap: 0,
          max_turns: 0,
          max_tool_calls: 0,
          wall_clock_ms: 123_000,
          cost_cap_usd: 0,
          handoff_at_turns: 0,
          default_tier: "cheap",
        },
      ],
    });
    expect(r).toMatchObject({ code: 0, err: "" });
    const own = unwrap(await listRunClasses(db.db)).find(
      (c) => c.name === LINT.runClass,
    );
    expect(own?.wall_clock_ms).toBe(123_000);
  });

  test("an install that has its own agent of that id keeps it", async () => {
    const db = await booted();
    unwrap(
      await seedRows(db.db, {
        agents: [
          {
            id: PARITY.agentId,
            name: "ours",
            kind: "util",
            runner_id: PARITY.runnerId,
            executor_id: PARITY.executor,
            created_at: 1,
          },
        ],
      }),
    );
    const r = await applyTo(db, "parity-own", { repos: [] });
    expect(r).toMatchObject({ code: 0, err: "" });
    expect(r.out).not.toContain("seeded the parity checker");
    expect(unwrap(await getAgent(db.db, PARITY.agentId)).name).toBe("ours");
  });
});
