import { FakeClock, renderMission, sha256Hex, systemClock } from "@bayon/core";
import { getAgent, openDb, type Db } from "@bayon/db";
import {
  SPINE_SEED,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  ApiErrorBody,
  MissionDiff,
  MissionVersion,
  MissionView,
} from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dbStore } from "./db-store.js";
import { startApi, type RunningApi } from "./server.js";

// /missions over HTTP against a temp-file DB (M1 contract 7). The tests run in order, each
// building on the versions the one before saved.

const TOKEN = "e2e-missions-0123456789abcdef";
const AGENT = SPINE_SEED.agentName;
const V1_TEXT = {
  who_md: "A builder.",
  what_md: "One README line.",
  how_md: "Edit README.md.",
  laws_md: "Touch nothing else.",
};
const V2_TEXT = {
  ...V1_TEXT,
  laws_md: "Touch nothing else.\nAsk before deleting.",
};

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 2));
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    logger: false,
  });
});

afterAll(async () => {
  await api?.close();
  await apiDb?.close();
  spine?.cleanup();
});

/** GET, or POST when there is a body. */
const call = (path: string, body?: unknown): Promise<Response> =>
  fetch(`${api.url}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const save = (body: unknown, agent: string = AGENT) =>
  call(`/missions/${agent}`, body);

async function expectError(res: Response, status: number, errorClass: string) {
  expect(res.status).toBe(status);
  const body = ApiErrorBody.parse(await res.json());
  expect(body.error.class).toBe(errorClass);
  return body.error;
}

async function history(): Promise<MissionView> {
  const res = await call(`/missions/${AGENT}`);
  expect(res.status).toBe(200);
  return MissionView.parse(await res.json());
}

const missionIdOfAgent = async () =>
  unwrap(await getAgent(spine.db, SPINE_SEED.agentId)).mission_id;

describe("missions", () => {
  test("before any save: no latest and no versions; an unknown agent is 404", async () => {
    expect(await history()).toEqual({
      agent: AGENT,
      latest: null,
      versions: [],
    });
    await expectError(await call("/missions/nobody"), 404, "not_found");
  });

  test("a save without a changelog note is 400 and writes nothing", async () => {
    for (const note of [undefined, "", "  \n"]) {
      await expectError(
        await save({ ...V1_TEXT, note, base_version: 0 }),
        400,
        "validation",
      );
    }
    expect((await history()).versions).toEqual([]);
    expect(await missionIdOfAgent()).toBeNull();
  });

  test("base 0 saves v1 (201); the agent points at it; its hash is reproducible from the text", async () => {
    const res = await save({ ...V1_TEXT, note: "first", base_version: 0 });
    expect(res.status).toBe(201);
    const v1 = MissionVersion.parse(await res.json());
    expect(v1).toMatchObject({
      ...V1_TEXT,
      agent_name: AGENT,
      version: 1,
      note: "first",
      created_by: "operator",
    });
    expect(v1.rendered_md).toBe(renderMission(AGENT, V1_TEXT));
    expect(v1.hash).toBe(await sha256Hex(renderMission(AGENT, v1)));
    expect(v1.hash).toBe(await sha256Hex(v1.rendered_md));
    expect(await missionIdOfAgent()).toBe(v1.id);
  });

  test("base = latest saves v+1 and repoints the agent", async () => {
    const res = await save({
      ...V2_TEXT,
      note: "ask before deleting",
      base_version: 1,
    });
    expect(res.status).toBe(201);
    const v2 = MissionVersion.parse(await res.json());
    expect(v2.version).toBe(2);
    expect(await missionIdOfAgent()).toBe(v2.id);
  });

  test("a stale base is 409 naming the current version, and writes nothing", async () => {
    const before = await missionIdOfAgent();
    for (const base_version of [0, 1, 5]) {
      const error = await expectError(
        await save({ ...V1_TEXT, note: "stale", base_version }),
        409,
        "conflict",
      );
      expect(error.current_version).toBe(2);
    }
    expect((await history()).versions).toHaveLength(2);
    expect(await missionIdOfAgent()).toBe(before);
  });

  test("GET is the latest version and the changelog, newest first", async () => {
    const view = await history();
    expect(view.latest).toMatchObject({ ...V2_TEXT, version: 2 });
    expect(view.versions.map((v) => [v.version, v.note])).toEqual([
      [2, "ask before deleting"],
      [1, "first"],
    ]);
    expect(view.versions[0]?.id).toBe(await missionIdOfAgent());
  });

  test("GET versions/:v is that version; an unknown one is 404, a non-number 400", async () => {
    const res = await call(`/missions/${AGENT}/versions/1`);
    expect(res.status).toBe(200);
    expect(MissionVersion.parse(await res.json())).toMatchObject({
      ...V1_TEXT,
      version: 1,
    });
    await expectError(
      await call(`/missions/${AGENT}/versions/9`),
      404,
      "not_found",
    );
    await expectError(
      await call(`/missions/${AGENT}/versions/zero`),
      400,
      "validation",
    );
  });

  test("GET diff/:a/:b is line by line, per section", async () => {
    const res = await call(`/missions/${AGENT}/diff/1/2`);
    expect(res.status).toBe(200);
    const diff = MissionDiff.parse(await res.json());
    expect(diff).toMatchObject({ agent: AGENT, from: 1, to: 2 });
    expect(diff.sections.map((s) => [s.section, s.changed])).toEqual([
      ["who", false],
      ["what", false],
      ["how", false],
      ["laws", true],
    ]);
    expect(diff.sections[3]?.changes).toEqual([
      { op: "same", text: "Touch nothing else.\n" },
      { op: "add", text: "Ask before deleting.\n" },
    ]);
    await expectError(
      await call(`/missions/${AGENT}/diff/1/9`),
      404,
      "not_found",
    );
  });

  test("a save for an unknown agent is 404; a body missing a section is 400", async () => {
    await expectError(
      await save({ ...V1_TEXT, note: "x", base_version: 0 }, "nobody"),
      404,
      "not_found",
    );
    await expectError(
      await save({
        ...V1_TEXT,
        laws_md: undefined,
        note: "x",
        base_version: 2,
      }),
      400,
      "validation",
    );
    expect((await history()).versions).toHaveLength(2);
  });
});
