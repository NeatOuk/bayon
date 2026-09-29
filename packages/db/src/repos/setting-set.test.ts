// setSettingFromCli, `frm settings set`'s writer, against a real temp database: the
// same check PUT /settings makes, the same settings.put audit row with via 'frm', and nothing
// written when the key is not governed, the value out of bounds, or already what it is.
import { FakeClock, err, ok } from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import { internalsOf } from "../connection.js";
import { getSettings } from "../index.js";
import {
  listAudit,
  seedRows,
  tempDb,
  unwrap,
  type TempDb,
} from "../testing.js";
import { setSettingFromCli, updateSettingFromCli } from "./setting-set.js";

const T0 = 1_700_000_000_000;
const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

async function db(): Promise<TempDb> {
  const t = unwrap(await tempDb(new FakeClock(T0)));
  opened.push(t);
  return t;
}

const valueOf = async (t: TempDb, key: string) =>
  unwrap(await getSettings(t.db, [key])).get(key);

test("sets a security control, audited as the operator's via frm, stamped now", async () => {
  const t = await db();
  expect(
    unwrap(await setSettingFromCli(t.db, "admission.require_certified", 0)),
  ).toEqual({
    key: "admission.require_certified",
    from: 1,
    to: 0,
    changed: true,
  });
  expect(await valueOf(t, "admission.require_certified")).toBe(0);
  expect(unwrap(await listAudit(t.db))).toMatchObject([
    {
      ts: T0,
      actor: "operator",
      action: "settings.put",
      target_kind: "setting",
      target_id: "admission.require_certified",
      payload_json: JSON.stringify({ via: "frm", from: 1, to: 0 }),
    },
  ]);
});

test("sets the untrusted roles, keeping the list as given", async () => {
  const t = await db();
  expect(
    unwrap(
      await setSettingFromCli(t.db, "executors.untrusted_roles", [
        "investigator",
        "reviewer",
      ]),
    ),
  ).toMatchObject({ changed: true, to: ["investigator", "reviewer"] });
  expect(await valueOf(t, "executors.untrusted_roles")).toEqual([
    "investigator",
    "reviewer",
  ]);
  // The empty list is a value, not an absence: every role may run on the trusted host.
  expect(
    unwrap(await setSettingFromCli(t.db, "executors.untrusted_roles", [])),
  ).toMatchObject({ changed: true, to: [] });
  expect(await valueOf(t, "executors.untrusted_roles")).toEqual([]);
});

test("a role that is no role is refused, and the list it would have nulled stands", async () => {
  // The second door: the CLI parser checked the role names and this writer did
  // not, so a value reaching it another way stored strings trustRefusal can never match — a list
  // that reads as set with the boundary off. Core's schema now refuses it here too.
  const t = await db();
  for (const value of [["REVIEWER"], [" builder "], ["reviewr"]]) {
    expect(
      await setSettingFromCli(t.db, "executors.untrusted_roles", value),
    ).toMatchObject({ ok: false, error: { class: "validation" } });
  }
  expect(await valueOf(t, "executors.untrusted_roles")).toEqual([
    "investigator",
  ]);
  expect(unwrap(await listAudit(t.db))).toEqual([]);
});

test("a key with no row yet reports from: null", async () => {
  // 016 seeds agents.git_author; with that row gone the key has none. (A database migrated short of
  // 016 would lack columns today's writers fill, e.g. 031's audit_log.workspace_id.)
  const t = await db();
  unwrap(internalsOf(t.db))
    .raw.prepare("DELETE FROM settings WHERE key = ?")
    .run("agents.git_author");
  unwrap(
    await seedRows(t.db, {
      settings: [{ key: "keep.me", value_json: "1", updated_at: T0 }],
    }),
  );
  expect(
    unwrap(
      await setSettingFromCli(t.db, "agents.git_author", "Bot <b@x.test>"),
    ),
  ).toEqual({
    key: "agents.git_author",
    from: null,
    to: "Bot <b@x.test>",
    changed: true,
  });
  expect(await valueOf(t, "agents.git_author")).toBe("Bot <b@x.test>");
  // Another key's row is left alone.
  expect(await valueOf(t, "keep.me")).toBe(1);
});

test("the value it already has writes nothing and audits nothing", async () => {
  const t = await db();
  unwrap(await setSettingFromCli(t.db, "backup.keep", 7));
  expect(unwrap(await setSettingFromCli(t.db, "backup.keep", 7))).toEqual({
    key: "backup.keep",
    from: 7,
    to: 7,
    changed: false,
  });
  expect(unwrap(await listAudit(t.db))).toHaveLength(1);
});

test.each([
  ["fleet.paused", "fleet.paused", 1, /frm pause \| frm resume/],
  ["an unknown key", "admission.recheck", 5_000, /is not a governed setting/],
  [
    "a key no schema governs",
    "preflight.margin_pct",
    5,
    /is not a governed setting/,
  ],
  ["a value out of bounds", "backup.at_utc_hour", 24, /backup\.at_utc_hour/],
  [
    "a require_certified that is not 0 or 1",
    "admission.require_certified",
    2,
    /admission\.require_certified/,
  ],
  [
    "a role list that is not a list",
    "executors.untrusted_roles",
    "reviewer",
    /executors\.untrusted_roles/,
  ],
  [
    "a git author that is not `Name <email>`",
    "agents.git_author",
    "nobody",
    /agents\.git_author/,
  ],
])(
  "refuses %s as validation, writing nothing",
  async (_what, key, value, why) => {
    const t = await db();
    const r = await setSettingFromCli(t.db, key, value);
    expect(r).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(!r.ok && r.error.message).toMatch(why);
    expect(unwrap(await listAudit(t.db))).toEqual([]);
  },
);

test("a refused key is not written even when it would have been a new row", async () => {
  const t = await db();
  await setSettingFromCli(t.db, "not.governed", 1);
  expect(await valueOf(t, "not.governed")).toBeUndefined();
});

test("updateSettingFromCli: reads, changes and writes in one transaction, audited like set", async () => {
  const t = await db();
  const key = "projects.local_roots";
  const seen: unknown[] = [];
  const add = (root: string) =>
    updateSettingFromCli(t.db, key, (from) => {
      seen.push(from);
      return ok([...(Array.isArray(from) ? from : []), root]);
    });
  expect(unwrap(await add("/a"))).toMatchObject({
    from: [],
    to: ["/a"],
    changed: true,
  });
  expect(unwrap(await add("/b"))).toMatchObject({
    from: ["/a"],
    to: ["/a", "/b"],
    changed: true,
  });
  expect(seen).toEqual([[], ["/a"]]);
  expect(await valueOf(t, key)).toEqual(["/a", "/b"]);
  const audit = unwrap(await listAudit(t.db)).filter(
    (r) => r.target_id === key,
  );
  expect(audit).toHaveLength(2);
  expect(
    audit.every((r) => r.action === "settings.put" && r.actor === "operator"),
  ).toBe(true);
});

test("updateSettingFromCli: the same value writes nothing; a refusal or a bad value writes nothing", async () => {
  const t = await db();
  const key = "projects.local_roots";
  expect(
    unwrap(await updateSettingFromCli(t.db, key, (from) => ok(from ?? []))),
  ).toMatchObject({ changed: false });
  const refused = await updateSettingFromCli(t.db, key, () =>
    err({ class: "validation", message: "no", retryable: false }),
  );
  expect(refused.ok).toBe(false);
  const bad = await updateSettingFromCli(t.db, key, () =>
    ok(["relative/path"]),
  );
  expect(bad.ok).toBe(false);
  const ungoverned = await updateSettingFromCli(t.db, "fleet.paused", () =>
    ok(1),
  );
  expect(ungoverned.ok).toBe(false);
  expect(await valueOf(t, key)).toEqual([]);
  expect(
    unwrap(await listAudit(t.db)).filter((r) => r.target_id === key),
  ).toEqual([]);
});
