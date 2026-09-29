// POST /projects/:id/pause and /resume over HTTP against a temp-file DB: 200 with the
// state after the call, idempotent, each real change audited; an unknown project 404; GET /projects
// shows the flag; another project is never touched.
import { FakeClock, systemClock } from "@bayon/core";
import { openDb, type Db } from "@bayon/db";
import {
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  ApiErrorBody,
  AuditPage,
  ProjectPauseState,
  ProjectsView,
} from "@bayon/proto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { dbStore } from "../db-store.js";
import { startApi, type RunningApi } from "../server.js";
import { ProjectsService } from "./projects-service.js";

const TOKEN = "e2e-project-pause-0123456789abcdef";

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;

const call = (method: string, path: string): Promise<Response> =>
  fetch(`${api.url}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}` },
  });

async function pausedOf(): Promise<Record<string, boolean>> {
  const res = await call("GET", "/projects");
  expect(res.status).toBe(200);
  return Object.fromEntries(
    ProjectsView.parse(await res.json()).projects.map((p) => [p.id, p.paused]),
  );
}

async function audits() {
  const res = await call("GET", "/audit?action=project.*");
  expect(res.status).toBe(200);
  return AuditPage.parse(await res.json()).items.toReversed();
}

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  unwrap(await seedSpine(spine.db, 1));
  unwrap(
    await seedRows(spine.db, {
      workspaces: [
        { id: "shop", name: "shop", kind: "single" },
        { id: "blog", name: "blog", kind: "single" },
      ],
    }),
  );
  apiDb = unwrap(await openDb({ path: spine.path, clock: systemClock }));
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    logger: false,
    projects: new ProjectsService({
      db: apiDb,
      clock: systemClock,
      mirrorsRoot: "/home/frm/mirrors",
    }),
  });
});

afterAll(async () => {
  await api?.close();
  await apiDb?.close();
  spine?.cleanup();
});

test("both doors need the operator's bearer", async () => {
  for (const path of ["/projects/shop/pause", "/projects/shop/resume"]) {
    const res = await fetch(`${api.url}${path}`, { method: "POST" });
    expect(res.status, path).toBe(401);
  }
});

test("pause, pause again, resume: 200 each, one audit row per real change, only that project", async () => {
  expect(await pausedOf()).toMatchObject({ shop: false, blog: false });

  const paused = await call("POST", "/projects/shop/pause");
  expect(paused.status).toBe(200);
  expect(ProjectPauseState.parse(await paused.json())).toEqual({
    project: "shop",
    paused: true,
    changed: true,
  });
  expect(await pausedOf()).toMatchObject({ shop: true, blog: false });

  const again = await call("POST", "/projects/shop/pause");
  expect(again.status).toBe(200);
  expect(ProjectPauseState.parse(await again.json())).toEqual({
    project: "shop",
    paused: true,
    changed: false,
  });

  const resumed = await call("POST", "/projects/shop/resume");
  expect(resumed.status).toBe(200);
  expect(ProjectPauseState.parse(await resumed.json())).toEqual({
    project: "shop",
    paused: false,
    changed: true,
  });
  expect(await pausedOf()).toMatchObject({ shop: false, blog: false });

  expect(
    (await audits()).map((a) => [
      a.actor,
      a.action,
      a.target_kind,
      a.target_id,
      a.payload,
    ]),
  ).toEqual([
    ["operator", "project.pause", "project", "shop", { via: "rest" }],
    ["operator", "project.resume", "project", "shop", { via: "rest" }],
  ]);
});

test("an unknown project is 404 and writes nothing", async () => {
  const before = (await audits()).length;
  for (const verb of ["pause", "resume"]) {
    const res = await call("POST", `/projects/nobody/${verb}`);
    expect(res.status, verb).toBe(404);
    const body = ApiErrorBody.parse(await res.json());
    expect(body.error.class).toBe("not_found");
    expect(body.error.message).toContain("project nobody does not exist");
  }
  expect(await audits()).toHaveLength(before);
});
