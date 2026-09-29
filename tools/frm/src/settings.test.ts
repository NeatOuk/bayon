// `frm settings get|set`: the shell door to the governed settings, and the only door to
// the two security controls. Parsing, the --yes gate, and the write against a real temp database.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_GIT_AUTHOR_KEY,
  FakeClock,
  GOVERNED_SETTING_KEYS,
  checkSeededSetting,
  LOCAL_ROOTS_KEY,
  LOGIN_IN_PLACE_KEY,
  READS_GRANTED_LOGIN,
  SHELL_ONLY_SETTINGS,
} from "@bayon/core";
import { getSettings, listAuditPage, openDb, type Db } from "@bayon/db";
import { migrateUp } from "@bayon/db/operator";
import { seedRows } from "@bayon/db/testing";
import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { parseCli } from "./cli.js";
import {
  defaultOf,
  parseSettingsCli,
  runSettingsCommand,
  SECURITY_CONTROLS,
  settingValueOf,
  type SettingsCommand,
} from "./settings.js";

const T0 = 1_700_000_000_000;
const dir = mkdtempSync(join(tmpdir(), "frm-settings-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const failure = (argv: string[]): string => {
  const parsed = parseSettingsCli(argv);
  return parsed.ok ? "parsed" : parsed.error.message;
};

describe("parseSettingsCli", () => {
  test("get with no key asks for every governed setting", () => {
    expect(parseSettingsCli(["settings", "get"])).toEqual({
      ok: true,
      value: { action: "get" },
    });
  });

  test("get names one key", () => {
    expect(
      parseSettingsCli(["settings", "get", "admission.require_certified"]),
    ).toEqual({
      ok: true,
      value: { action: "get", key: "admission.require_certified" },
    });
  });

  test("a numeric key's value is a number, not its text", () => {
    expect(
      parseSettingsCli([
        "settings",
        "set",
        "admission.require_certified",
        "0",
        "--yes",
      ]),
    ).toEqual({
      ok: true,
      value: {
        action: "set",
        key: "admission.require_certified",
        value: 0,
        yes: true,
      },
    });
  });

  test("the roles are a comma-separated list, deduplicated; none clears it", () => {
    expect(
      settingValueOf(
        "executors.untrusted_roles",
        "investigator, reviewer,investigator",
      ),
    ).toEqual({
      ok: true,
      value: ["investigator", "reviewer"],
    });
    expect(settingValueOf("executors.untrusted_roles", "none")).toEqual({
      ok: true,
      value: [],
    });
    expect(settingValueOf("executors.untrusted_roles", "")).toEqual({
      ok: true,
      value: [],
    });
  });

  test("a key with no numeric shape keeps its text", () => {
    expect(settingValueOf("agents.git_author", "Bot <b@x.test>")).toEqual({
      ok: true,
      value: "Bot <b@x.test>",
    });
  });

  test("frm settings reaches this parser through parseCli", () => {
    expect(parseCli(["settings", "get", "backup.keep"])).toEqual({
      ok: true,
      value: {
        command: "settings",
        options: { action: "get", key: "backup.keep" },
      },
    });
  });

  test.each([
    [["settings"], "usage"],
    [["settings", "list"], "usage"],
    [["settings", "get", "backup.keep", "3"], "usage"],
    [["settings", "set", "backup.keep"], "usage"],
    [["settings", "set", "backup.keep", "3", "extra"], "usage"],
    [["settings", "set", "backup.keep", "3", "--force"], "Unknown option"],
    // fleet.paused has its own audited doors, and says so rather than "unknown key".
    [["settings", "set", "fleet.paused", "1"], "frm pause | frm resume"],
    [["settings", "get", "fleet.paused"], "frm pause | frm resume"],
    // the gate settings are config, and the refusal names the door that sets them.
    [
      ["settings", "set", "gates.base_drift", "warn"],
      'gates.base_drift is a gate setting: set it with frm config apply <file.json>, the file holding {"settings": {"gates.base_drift": <value>}}',
    ],
    [["settings", "get", "gates.timeout_retries"], "frm config apply"],
    [["settings", "set", "nope.nope", "1"], "is not a governed setting"],
    [["settings", "get", "retention.events_days"], "is not a governed setting"],
    [["settings", "set", "backup.keep", "many"], "takes a number"],
    // Refused here for the pointed message; core's schema refuses it again at the writer, and at
    // every other door that writes the setting.
    [
      ["settings", "set", "executors.untrusted_roles", "reviewer,auditor"],
      'executors.untrusted_roles: "auditor" is not a role (orchestrator, builder, reviewer, investigator)',
    ],
  ])("%j is refused (%s)", (argv, reason) => {
    expect(failure(argv)).toContain(reason);
  });
});

test("every shell-only setting core lists but the git identity is gated and explained", async () => {
  // The --yes gate used to be a two-key literal here while the canonical list is core's
  // SHELL_ONLY_SETTINGS. A fourth security key added there would have been written with no gate
  // and no explanation, invisibly: this is what relates the two.
  expect(SECURITY_CONTROLS.toSorted()).toEqual(
    Object.keys(SHELL_ONLY_SETTINGS)
      .filter((key) => key !== AGENT_GIT_AUTHOR_KEY)
      .toSorted(),
  );
  for (const key of SECURITY_CONTROLS) {
    const said: string[] = [];
    const io = {
      // No FRM_HOME: the gate refuses before any database is opened, so nothing can be written.
      env: {},
      clock: new FakeClock(T0),
      out: (line: string) => said.push(line),
      err: (line: string) => said.push(line),
    };
    expect(
      await runSettingsCommand(
        { action: "set", key, value: 0, yes: false },
        io,
      ),
    ).toBe(2);
    expect(said[0]).not.toBe(`${key}: `); // the effect, in words, before anything else
    expect(said.join("\n")).toContain("repeat the command with --yes");
  }
});

describe("runSettingsCommand", () => {
  const home = join(dir, "home");
  const lines: string[] = [];
  const io = {
    env: { FRM_HOME: home },
    clock: new FakeClock(T0),
    out: (line: string) => lines.push(line),
    err: (line: string) => lines.push(line),
  };
  const run = (argv: string[]) => {
    const parsed = parseSettingsCli(argv);
    if (!parsed.ok) throw new Error(parsed.error.message);
    lines.length = 0;
    return runSettingsCommand(parsed.value, io);
  };
  const withDb = async <T>(f: (db: Db) => Promise<T>): Promise<T> => {
    const opened = await openDb({
      path: join(home, "foreman.db"),
      clock: new FakeClock(T0),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    try {
      return await f(opened.value);
    } finally {
      await opened.value.close();
    }
  };

  beforeEach(async () => {
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    await withDb(async (db) => {
      const migrated = await migrateUp(db, {});
      if (!migrated.ok) throw new Error(migrated.error.message);
    });
  });

  test("get lists every governed setting, marking the security controls", async () => {
    expect(await run(["settings", "get"])).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("admission.recheck_ms = 5000");
    expect(text).toContain("admission.require_certified = 1");
    expect(text).toContain('executors.untrusted_roles = ["investigator"]');
    expect(text).toContain("security control:");
    // Never a key the GUI owns but no schema governs, and never fleet.paused.
    expect(text).not.toContain("retention.events_days");
    expect(text).not.toContain("fleet.paused");
  });

  test("get names one key", async () => {
    expect(await run(["settings", "get", "backup.keep"])).toBe(0);
    expect(lines).toEqual(["backup.keep = 14"]);
  });

  test("the default it prints for a key is what a fresh database holds", async () => {
    // defaultOf carries the seeded values as literals (007, 012). A seed that moved and a line
    // here that did not is a lie an operator would act on, so the two are held together.
    const rows = await withDb(async (db) =>
      unwrapOk(await getSettings(db, GOVERNED_SETTING_KEYS)),
    );
    for (const key of GOVERNED_SETTING_KEYS) {
      // 016 seeds an identity, and what it falls back to is prose, not a value.
      if (key === AGENT_GIT_AUTHOR_KEY) continue;
      expect([key, defaultOf(key)]).toEqual([
        key,
        JSON.stringify(rows.get(key)),
      ]);
    }
  });

  test("a key with no row shows the default its reader falls back to", async () => {
    // 016 seeds agents.git_author: a database one migration short of it has no row for the key.
    const short = join(dir, "short");
    rmSync(short, { recursive: true, force: true });
    mkdirSync(short, { recursive: true });
    const opened = await openDb({
      path: join(short, "foreman.db"),
      clock: new FakeClock(T0),
    });
    unwrapOk(opened);
    try {
      unwrapOk(await migrateUp(unwrapOk(opened), { to: 15 }));
    } finally {
      await unwrapOk(opened).close();
    }
    lines.length = 0;
    expect(
      await runSettingsCommand(
        { action: "get", key: "agents.git_author" },
        { ...io, env: { FRM_HOME: short } },
      ),
    ).toBe(0);
    expect(lines).toEqual([
      "agents.git_author = (not set; default the built-in agent identity)",
    ]);
  });

  test("set writes a governed setting and audits it via frm", async () => {
    expect(await run(["settings", "set", "backup.keep", "7"])).toBe(0);
    expect(lines.join("\n")).toContain(
      "backup.keep: 14 -> 7 (audited: settings.put via frm)",
    );
    expect(
      await withDb(async (db) =>
        unwrapOk(await getSettings(db, ["backup.keep"])).get("backup.keep"),
      ),
    ).toBe(7);
    const audit = await withDb(
      async (db) => unwrapOk(await listAuditPage(db, { limit: 10 })).rows,
    );
    expect(audit).toMatchObject([
      {
        actor: "operator",
        action: "settings.put",
        target_id: "backup.keep",
        payload_json: JSON.stringify({ via: "frm", from: 14, to: 7 }),
      },
    ]);
  });

  test("the value it already has writes nothing", async () => {
    expect(await run(["settings", "set", "backup.keep", "14"])).toBe(0);
    expect(lines.join("\n")).toContain("already 14; nothing written");
    expect(
      await withDb(
        async (db) => unwrapOk(await listAuditPage(db, { limit: 10 })).rows,
      ),
    ).toEqual([]);
  });

  // The point of the ticket: a security control is explained, and refused without --yes.
  test("a security control without --yes prints the effect and writes nothing", async () => {
    expect(
      await run(["settings", "set", "admission.require_certified", "0"]),
    ).toBe(2);
    const text = lines.join("\n");
    expect(text).toContain("lets a runner nobody has certified run unattended");
    expect(text).toContain("setting it to 0");
    expect(text).toContain("repeat the command with --yes");
    expect(
      await withDb(async (db) =>
        unwrapOk(await getSettings(db, ["admission.require_certified"])).get(
          "admission.require_certified",
        ),
      ),
    ).toBe(1);
    expect(
      await withDb(
        async (db) => unwrapOk(await listAuditPage(db, { limit: 10 })).rows,
      ),
    ).toEqual([]);
  });

  test("with --yes it prints the effect and writes", async () => {
    expect(
      await run([
        "settings",
        "set",
        "admission.require_certified",
        "0",
        "--yes",
      ]),
    ).toBe(0);
    const text = lines.join("\n");
    expect(text).toContain("lets a runner nobody has certified run unattended");
    expect(text).toContain("admission.require_certified: 1 -> 0");
    expect(
      await withDb(async (db) =>
        unwrapOk(await getSettings(db, ["admission.require_certified"])).get(
          "admission.require_certified",
        ),
      ),
    ).toBe(0);
  });

  test("the trust rule takes a role list", async () => {
    expect(
      await run([
        "settings",
        "set",
        "executors.untrusted_roles",
        "reviewer,investigator",
        "--yes",
      ]),
    ).toBe(0);
    expect(
      await withDb(async (db) =>
        unwrapOk(await getSettings(db, ["executors.untrusted_roles"])).get(
          "executors.untrusted_roles",
        ),
      ),
    ).toEqual(["reviewer", "investigator"]);
  });

  test("a value out of bounds is refused by the database, writing nothing", async () => {
    expect(await run(["settings", "set", "backup.at_utc_hour", "24"])).toBe(1);
    expect(lines.join("\n")).toContain("nothing written");
    expect(
      await withDb(async (db) =>
        unwrapOk(await getSettings(db, ["backup.at_utc_hour"])).get(
          "backup.at_utc_hour",
        ),
      ),
    ).toBe(3);
  });

  test("the Jira quick pass is set like the full sync: 0 turns it off, under a minute is refused", async () => {
    const quick = "jira.quick_interval_ms";
    const stored = () =>
      withDb(async (db) => unwrapOk(await getSettings(db, [quick])).get(quick));
    expect(await run(["settings", "get", quick])).toBe(0);
    expect(lines).toEqual([`${quick} = 60000`]);
    expect(await run(["settings", "set", quick, "0"])).toBe(0);
    expect(lines.join("\n")).toContain(`${quick}: 60000 -> 0`);
    expect(await stored()).toBe(0);
    expect(await run(["settings", "set", quick, "30000"])).toBe(1);
    expect(lines.join("\n")).toContain("nothing written");
    expect(await stored()).toBe(0);
    expect(await run(["settings", "set", quick, "300000"])).toBe(0);
    expect(await stored()).toBe(300_000);
  });

  test("no database is a usage error", async () => {
    const cmd: SettingsCommand = { action: "get" };
    lines.length = 0;
    expect(await runSettingsCommand(cmd, { ...io, env: {} })).toBe(2);
    expect(lines.join("\n")).toContain("set FRM_HOME");
  });
});

function unwrapOk<T>(
  r: { ok: true; value: T } | { ok: false; error: { message: string } },
): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

describe("projects.local_roots (§14)", () => {
  test("a comma-separated list of folders, trimmed and deduplicated", () => {
    expect(
      settingValueOf(
        LOCAL_ROOTS_KEY,
        " /home/op/My Projects , /srv/src,/srv/src",
      ),
    ).toEqual({ ok: true, value: ["/home/op/My Projects", "/srv/src"] });
  });

  test.each(["none", "", "  "])("%j allows no folder", (raw) => {
    expect(settingValueOf(LOCAL_ROOTS_KEY, raw)).toEqual({
      ok: true,
      value: [],
    });
  });

  test.each(["relative/src", "/srv/../etc", "/srv/src/"])(
    "%j is refused by core's schema",
    (raw) => {
      const value = settingValueOf(LOCAL_ROOTS_KEY, raw);
      expect(value.ok).toBe(true);
      if (!value.ok) return;
      expect(checkSeededSetting(LOCAL_ROOTS_KEY, value.value).ok).toBe(false);
    },
  );

  test("it is a security control", () => {
    expect(SECURITY_CONTROLS).toContain(LOCAL_ROOTS_KEY);
  });
});

describe("runners.login_in_place (§14)", () => {
  test("pairs become a map of runner id to path", () => {
    expect(
      settingValueOf(LOGIN_IN_PLACE_KEY, " a-runner=/home/op/.x/auth.json "),
    ).toEqual({ ok: true, value: { "a-runner": "/home/op/.x/auth.json" } });
    expect(
      settingValueOf(LOGIN_IN_PLACE_KEY, "a=/one/auth.json,b=/two/auth.json"),
    ).toEqual({
      ok: true,
      value: { a: "/one/auth.json", b: "/two/auth.json" },
    });
  });

  test.each(["none", "", "  "])("%j revokes every grant", (raw) => {
    expect(settingValueOf(LOGIN_IN_PLACE_KEY, raw)).toEqual({
      ok: true,
      value: {},
    });
  });

  test.each([
    "a-runner",
    "=/a/auth.json",
    "a-runner=",
    "a-runner=/x,a-runner=/y",
  ])("%j is refused", (raw) => {
    expect(settingValueOf(LOGIN_IN_PLACE_KEY, raw)).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });

  /** A migrated database in its own FRM_HOME, holding these runner rows (the supervisor's, at boot). */
  async function consentHome(
    name: string,
    runners: readonly (readonly [string, Record<string, unknown>])[],
  ): Promise<string> {
    const home = join(dir, name);
    rmSync(home, { recursive: true, force: true });
    mkdirSync(home, { recursive: true });
    const opened = await openDb({
      path: join(home, "foreman.db"),
      clock: new FakeClock(T0),
    });
    if (!opened.ok) throw new Error(opened.error.message);
    const migrated = await migrateUp(opened.value, {});
    if (!migrated.ok) throw new Error(migrated.error.message);
    const seeded = await seedRows(opened.value, {
      runners: runners.map(([id, defaults]) => ({
        id,
        kind: "script",
        adapter: id,
        caps_json: "{}",
        defaults_json: JSON.stringify(defaults),
      })),
    });
    if (!seeded.ok) throw new Error(seeded.error.message);
    await opened.value.close();
    return home;
  }

  test.each([
    ["a runner that cannot read a login in place", [["a-runner", {}]]],
    [
      "a runner whose defaults say false",
      [["a-runner", { [READS_GRANTED_LOGIN]: false }]],
    ],
    ["a runner that is not registered", []],
  ] as const)(
    "a grant to %s is refused, naming the setting and the runner, and nothing is written",
    async (_what, runners) => {
      const home = await consentHome("refused", runners);
      const said: string[] = [];
      const io = {
        env: { FRM_HOME: home },
        clock: new FakeClock(T0),
        out: (line: string) => said.push(line),
        err: (line: string) => said.push(line),
      };
      const value = { "a-runner": "/home/op/.a/auth.json" };
      expect(
        await runSettingsCommand(
          { action: "set", key: LOGIN_IN_PLACE_KEY, value, yes: true },
          io,
        ),
      ).toBe(1);
      const text = said.join("\n");
      expect(text).toContain("nothing written");
      expect(text).toContain(LOGIN_IN_PLACE_KEY);
      expect(text).toContain("a-runner");
      const db = await openDb({
        path: join(home, "foreman.db"),
        clock: new FakeClock(T0),
      });
      if (!db.ok) throw new Error(db.error.message);
      try {
        const rows = await getSettings(db.value, [LOGIN_IN_PLACE_KEY]);
        expect(rows.ok && rows.value.get(LOGIN_IN_PLACE_KEY)).toEqual({});
      } finally {
        await db.value.close();
      }
    },
  );

  test("revoking needs no runner at all", async () => {
    const home = await consentHome("revoke", []);
    const io = {
      env: { FRM_HOME: home },
      clock: new FakeClock(T0),
      out: () => undefined,
      err: () => undefined,
    };
    expect(
      await runSettingsCommand(
        { action: "set", key: LOGIN_IN_PLACE_KEY, value: {}, yes: true },
        io,
      ),
    ).toBe(0);
  });

  test("it is a security control: --yes, and the write is audited", async () => {
    const home = await consentHome("consent", [
      ["a-runner", { [READS_GRANTED_LOGIN]: true }],
    ]);

    const said: string[] = [];
    const io = {
      env: { FRM_HOME: home },
      clock: new FakeClock(T0),
      out: (line: string) => said.push(line),
      err: (line: string) => said.push(line),
    };
    const value = { "a-runner": "/home/op/.a/auth.json" };
    expect(SECURITY_CONTROLS).toContain(LOGIN_IN_PLACE_KEY);
    expect(
      await runSettingsCommand(
        { action: "set", key: LOGIN_IN_PLACE_KEY, value, yes: false },
        io,
      ),
    ).toBe(2);
    expect(said.join("\n")).toContain("repeat the command with --yes");
    said.length = 0;
    expect(
      await runSettingsCommand(
        { action: "set", key: LOGIN_IN_PLACE_KEY, value, yes: true },
        io,
      ),
    ).toBe(0);

    const db = await openDb({
      path: join(home, "foreman.db"),
      clock: new FakeClock(T0),
    });
    if (!db.ok) throw new Error(db.error.message);
    try {
      const rows = await getSettings(db.value, [LOGIN_IN_PLACE_KEY]);
      expect(rows.ok && rows.value.get(LOGIN_IN_PLACE_KEY)).toEqual(value);
      const audit = await listAuditPage(db.value, { limit: 5 });
      expect(
        audit.ok &&
          audit.value.rows.some(
            (r) =>
              r.action === "settings.put" && r.target_id === LOGIN_IN_PLACE_KEY,
          ),
      ).toBe(true);
    } finally {
      await db.value.close();
    }
  });
});
