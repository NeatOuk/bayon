import { FakeClock, renderMission, sha256Hex } from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { internalsOf, openDb } from "../connection.js";
import { SPINE_SEED, seedSpine, tempDb, unwrap } from "../testing.js";
import { getAgent } from "./config.js";
import {
  getMissionHistory,
  getMissionVersion,
  insertMissionVersion,
  type NewMissionVersion,
} from "./missions.js";

const T0 = 1_700_000_000_000;
const clock = new FakeClock(T0);
const t = unwrap(await tempDb(clock));
unwrap(await seedSpine(t.db, 2));
afterAll(() => t.cleanup());
const { raw } = unwrap(internalsOf(t.db));
const missionCount = () =>
  raw.prepare("SELECT count(*) AS n FROM missions").get();
const AGENT = SPINE_SEED.agentName;

const input = (
  base_version: number,
  over: Partial<NewMissionVersion> = {},
): NewMissionVersion => ({
  agent_name: AGENT,
  base_version,
  who_md: "A builder.",
  what_md: "One README line.",
  how_md: "Edit README.md.",
  laws_md: "Touch nothing else.",
  note: `v${base_version + 1}`,
  created_by: "operator",
  ...over,
});

const missionIdOfAgent = async () =>
  unwrap(await getAgent(t.db, SPINE_SEED.agentId)).mission_id;

test("an agent with no mission has an empty history; an unknown agent is not_found", async () => {
  expect(unwrap(await getMissionHistory(t.db, AGENT))).toEqual({
    latest: null,
    versions: [],
  });
  expect(await getMissionHistory(t.db, "nobody")).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
});

test("the first version is base 0 → v1: rendered, hashed, and the agent points at it", async () => {
  const v1 = unwrap(await insertMissionVersion(t.db, input(0)));
  const rendered = renderMission(AGENT, input(0));
  expect(v1).toMatchObject({
    agent_name: AGENT,
    version: 1,
    rendered_md: rendered,
    hash: await sha256Hex(rendered),
    note: "v1",
    created_at: T0,
    created_by: "operator",
  });
  expect(await missionIdOfAgent()).toBe(v1.id);
});

test("base = latest inserts v+1 and repoints the agent; history is newest first", async () => {
  await clock.advance(1_000);
  const v2 = unwrap(
    await insertMissionVersion(t.db, input(1, { laws_md: "Touch less." })),
  );
  expect(v2.version).toBe(2);
  expect(await missionIdOfAgent()).toBe(v2.id);
  const history = unwrap(await getMissionHistory(t.db, AGENT));
  expect(history.latest).toEqual(v2);
  expect(history.versions.map((v) => [v.version, v.note])).toEqual([
    [2, "v2"],
    [1, "v1"],
  ]);
  expect(Object.keys(history.versions[0] ?? {}).sort()).toEqual([
    "created_at",
    "created_by",
    "hash",
    "id",
    "note",
    "version",
  ]);
});

test("the stored hash is reproducible from the stored text", async () => {
  for (const version of [1, 2]) {
    const row = unwrap(await getMissionVersion(t.db, AGENT, version));
    expect(await sha256Hex(renderMission(row.agent_name, row))).toBe(row.hash);
    expect(await sha256Hex(row.rendered_md)).toBe(row.hash);
  }
});

test("a stale base is conflict carrying the current version, and writes nothing", async () => {
  const before = await missionIdOfAgent();
  const count = missionCount();
  for (const base of [0, 1, 3]) {
    const stale = await insertMissionVersion(t.db, input(base));
    expect(stale).toMatchObject({
      ok: false,
      error: { class: "conflict", cause: { current_version: 2 } },
    });
  }
  expect(missionCount()).toEqual(count);
  expect(await missionIdOfAgent()).toBe(before);
});

test("two saves from the same base: exactly one wins, across connections", async () => {
  const other = unwrap(await openDb({ path: t.path, clock }));
  try {
    const results = await Promise.all([
      insertMissionVersion(t.db, input(2, { note: "mine" })),
      insertMissionVersion(other, input(2, { note: "theirs" })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.find((r) => !r.ok)).toMatchObject({
      error: { class: "conflict", cause: { current_version: 3 } },
    });
  } finally {
    await other.close();
  }
});

test("a blank note is validation; an unknown agent is not_found; neither writes", async () => {
  const count = missionCount();
  expect(
    await insertMissionVersion(t.db, input(3, { note: " \n" })),
  ).toMatchObject({ ok: false, error: { class: "validation" } });
  expect(
    await insertMissionVersion(t.db, input(0, { agent_name: "nobody" })),
  ).toMatchObject({ ok: false, error: { class: "not_found" } });
  expect(missionCount()).toEqual(count);
});

test("a version that does not exist is not_found", async () => {
  expect(await getMissionVersion(t.db, AGENT, 99)).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
  expect(await getMissionVersion(t.db, "nobody", 1)).toMatchObject({
    ok: false,
    error: { class: "not_found" },
  });
});
