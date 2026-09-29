// `frm agent set`: an existing agent's profile, enabled and max_concurrency, through
// @bayon/db/operator into a real temp database, audited as the operator's via frm; refused, with
// nothing written, for an unknown agent or profile, another runner's profile, or mission_id.
import { dirname } from "node:path";
import { FakeClock } from "@bayon/core";
import { getAgent } from "@bayon/db";
import {
  listAudit,
  seedRows,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import { afterEach, expect, test } from "vitest";
import { parseAgentCli, runAgentCommand, type AgentIo } from "./agent-set.js";
import { parseCli } from "./cli.js";

const T0 = 1_700_000_000_000;
const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

const runner = (id: string) => ({
  id,
  kind: "script",
  adapter: "fixture",
  caps_json: "{}",
});
const profile = (id: string, runnerId: string) => ({
  id,
  name: id,
  runner_id: runnerId,
  model_tier: "standard",
  version: 1,
  hash: "0".repeat(64),
  created_at: T0,
});

/** Two runners, a profile for each plus a spare for r1, and builder b1 on r1 with profile p1. */
async function db(): Promise<TempDb> {
  const t = unwrap(await tempDb(new FakeClock(T0)));
  opened.push(t);
  unwrap(
    await seedRows(t.db, {
      runners: [runner("r1"), runner("r2")],
      profiles: [
        profile("p1", "r1"),
        profile("p1b", "r1"),
        profile("p2", "r2"),
      ],
      agents: [
        {
          id: "b1",
          name: "b1",
          kind: "builder",
          runner_id: "r1",
          profile_id: "p1",
          created_at: T0,
        },
      ],
    }),
  );
  return t;
}

function rig(env: AgentIo["env"]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: AgentIo = {
    env,
    clock: new FakeClock(T0),
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { io, out, err };
}

const set = (t: TempDb, argv: readonly string[]) => {
  const cmd = parseAgentCli(["agent", "set", ...argv]);
  if (!cmd.ok) throw new Error(cmd.error.message);
  const r = rig({ FRM_DB: t.path });
  return runAgentCommand(cmd.value, r.io).then((code) => ({ code, ...r }));
};

test("parse: flags to a patch; parseCli routes `agent`", () => {
  expect(
    parseCli([
      "agent",
      "set",
      "b1",
      "--profile",
      "p1b",
      "--enabled",
      "false",
      "--max-concurrency",
      "0",
    ]),
  ).toEqual({
    ok: true,
    value: {
      command: "agent",
      options: {
        id: "b1",
        patch: { profile_id: "p1b", enabled: false, max_concurrency: 0 },
      },
    },
  });
  expect(parseAgentCli(["agent", "set", "b1", "--enabled", "true"])).toEqual({
    ok: true,
    value: { id: "b1", patch: { enabled: true } },
  });
});

test.each([
  [["agent", "set", "b1"], /at least one of --profile/],
  [["agent", "set", "--enabled", "true"], /usage: frm agent set/],
  [["agent", "set", "b1", "b2", "--enabled", "true"], /usage: frm agent set/],
  [["agent", "get", "b1", "--enabled", "true"], /usage: frm agent set/],
  [["agent", "set", "b1", "--enabled", "yes"], /--enabled takes true or false/],
  [["agent", "set", "b1", "--max-concurrency=-1"], /whole number/],
  // parseArgs itself refuses a dash-led value given as the next word.
  [["agent", "set", "b1", "--max-concurrency", "-1"], /ambiguous/],
  [["agent", "set", "b1", "--max-concurrency", "1.5"], /whole number/],
  [["agent", "set", "b1", "--profile", ""], /--profile takes a profile id/],
  [["agent", "set", "b1", "--colour", "red"], /colour/],
  [
    ["agent", "set", "b1", "--mission-id", "m-1"],
    /mission_id is set by the API \(POST \/missions\)/,
  ],
  [["agent", "set", "b1", "--mission_id=m-1"], /mission_id is set by the API/],
])("parse refuses %j", (argv, why) => {
  const r = parseAgentCli(argv);
  expect(r.ok).toBe(false);
  expect(!r.ok && r.error.message).toMatch(why);
});

test("sets the profile, enabled and max_concurrency, audited as the operator's via frm", async () => {
  const t = await db();
  const r = await set(t, [
    "b1",
    "--profile",
    "p1b",
    "--enabled",
    "false",
    "--max-concurrency",
    "3",
  ]);
  expect(r).toMatchObject({ code: 0, err: [] });
  expect(r.out).toEqual([
    "agent b1: profile_id p1 -> p1b, enabled 1 -> 0, max_concurrency 1 -> 3 (audited: agent.set via frm)",
  ]);
  expect(unwrap(await getAgent(t.db, "b1"))).toMatchObject({
    profile_id: "p1b",
    enabled: 0,
    max_concurrency: 3,
    mission_id: null,
  });
  const audit = unwrap(await listAudit(t.db)).map((a) => [
    a.actor,
    a.action,
    a.target_kind,
    a.target_id,
    a.payload_json === null ? null : JSON.parse(a.payload_json),
  ]);
  expect(audit).toEqual([
    [
      "operator",
      "agent.set",
      "agent",
      "b1",
      {
        via: "frm",
        from: { profile_id: "p1", enabled: 1, max_concurrency: 1 },
        to: { profile_id: "p1b", enabled: 0, max_concurrency: 3 },
      },
    ],
  ]);
});

test("values it already has write nothing and audit nothing; a change audits only what moved", async () => {
  const t = await db();
  const same = await set(t, ["b1", "--profile", "p1", "--enabled", "true"]);
  expect(same).toMatchObject({
    code: 0,
    out: ["agent b1: already so; nothing written"],
  });
  expect(unwrap(await listAudit(t.db))).toEqual([]);
  const retire = await set(t, ["b1", "--enabled", "false", "--profile", "p1"]);
  expect(retire.out).toEqual([
    "agent b1: enabled 1 -> 0 (audited: agent.set via frm)",
  ]);
  expect(unwrap(await listAudit(t.db)).map((a) => a.payload_json)).toEqual([
    JSON.stringify({ via: "frm", from: { enabled: 1 }, to: { enabled: 0 } }),
  ]);
});

test.each([
  [["nobody", "--enabled", "false"], "agent nobody does not exist"],
  [["b1", "--profile", "p9"], "profile p9 does not exist"],
  [
    ["b1", "--profile", "p2"],
    "profile p2 is for runner r2, not agent b1's runner r1",
  ],
])("refused by the database, nothing written: %j", async (argv, why) => {
  const t = await db();
  const r = await set(t, argv);
  expect(r.code).toBe(1);
  expect(r.err).toEqual([`frm agent set: nothing written: ${why}`]);
  expect(unwrap(await getAgent(t.db, "b1"))).toMatchObject({
    profile_id: "p1",
    enabled: 1,
  });
  expect(unwrap(await listAudit(t.db))).toEqual([]);
});

test("no database: exit 2, and none is created", async () => {
  const cmd = unwrap(
    parseAgentCli(["agent", "set", "b1", "--enabled", "false"]),
  );
  const none = rig({});
  expect(await runAgentCommand(cmd, none.io)).toBe(2);
  expect(none.err[0]).toContain("set FRM_HOME (or FRM_DB)");
  const t = await db();
  const missing = rig({ FRM_HOME: `${dirname(t.path)}/nowhere` });
  expect(await runAgentCommand(cmd, missing.io)).toBe(2);
  expect(missing.err[0]).toContain("no database at");
});
