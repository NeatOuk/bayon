// GET /gates?project=, /inbox?project= and /spend?project= over HTTP against a temp-file DB
//: one project's reviews, inbox and spend inside its IDE. An unknown project is an empty
// result, an empty value is 400, and without the filter each body is the fleet's, as before.
import { FakeClock, systemClock } from "@bayon/core";
import { getSpendReport, openDb, type Db } from "@bayon/db";
import {
  SPINE_SEED,
  newSessionInput,
  seedRows,
  seedSpine,
  tempDb,
  ticketRow,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import {
  ApiErrorBody,
  GatesPage,
  InboxPage,
  SpendReport,
  type SpendGroup,
} from "@bayon/proto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { dbStore } from "./db-store.js";
import { gate } from "./gates/fixtures.js";
import { GateService } from "./gates/gate-service.js";
import { startApi, type RunningApi } from "./server.js";

const TOKEN = "e2e-project-scope-0123456789abcdef";
/** The API's database reads at this fixed time, so two spend reads are byte for byte alike. */
const NOW = Date.UTC(2026, 8, 13, 10);
const HASH = "0".repeat(64);

let spine: TempDb;
let apiDb: Db;
let api: RunningApi;

const get = (path: string): Promise<Response> =>
  fetch(`${api.url}${path}`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  });

const request = (
  id: string,
  o: {
    readonly ticket_id?: string;
    readonly session_id?: string;
    readonly answered?: boolean;
  },
) => ({
  id,
  kind: "decision",
  question: `question ${id}`,
  context_md: null,
  options_json: null,
  batch_id: null,
  answer_json: o.answered === true ? '"yes"' : null,
  answered_by: o.answered === true ? "operator" : null,
  status: o.answered === true ? "answered" : "open",
  asked_at: Number(id.slice(1)),
  answered_at: o.answered === true ? 100 : null,
  expires_at: null,
  dedupe_key: null,
  proposal_json: null,
  ticket_id: o.ticket_id ?? null,
  session_id: o.session_id ?? null,
});

/** A run of `session_id` (its `seq`-th) and its spend row, `id` for both. */
function spent(
  id: string,
  session_id: string,
  cost_usd: number,
  o: {
    readonly seq?: number;
    readonly ticket_id?: string;
    readonly phase?: string;
  } = {},
) {
  return {
    run: {
      id,
      session_id,
      seq: o.seq ?? 1,
      trigger: "operator",
      template_id: null,
      prompt_path: "/tmp/bayon-fixture/prompt.md",
      prompt_tokens_est: null,
      prompt_tokens_actual: null,
      prompt_hash: HASH,
      context_hash: HASH,
      mission_hash: null,
      doctrine_hash: null,
      toolset_hash: null,
      config_hash: null,
      model: null,
      effort: null,
      base_sha: null,
      truncated_sections_json: null,
      state: "ok" as const,
      started_at: NOW - 60_000,
    },
    spend: {
      id,
      run_id: id,
      session_id,
      ticket_id: o.ticket_id ?? null,
      gate_id: null,
      pulse_id: null,
      phase: o.phase ?? "build",
      runner_id: SPINE_SEED.runnerId,
      model: "model-a",
      tokens_tool_result: null,
      cost_usd,
      cost_source: "reported",
      cache_hit_ratio: null,
      ts: NOW - 60_000,
    },
  };
}

beforeAll(async () => {
  spine = unwrap(await tempDb(new FakeClock(NOW)));
  unwrap(await seedSpine(spine.db, 3));
  const agent = (id: string, workspace_id: string) => ({
    id,
    name: id,
    kind: "builder" as const,
    runner_id: SPINE_SEED.runnerId,
    workspace_id,
    created_at: 0,
  });
  const session = (id: string, agent_id: string, ticket_id: string) => ({
    ...newSessionInput(),
    id,
    agent_id,
    ticket_id,
    state: "idle" as const,
    created_at: 0,
  });
  const costs = [
    spent("shop-1", "s-shop", 3, { ticket_id: "ticket-4" }),
    spent("shop-2", "s-shop", 1, { seq: 2, phase: "review" }),
    spent("blog-1", "s-blog", 7, { ticket_id: "ticket-5" }),
    spent("fleet-1", SPINE_SEED.sessionId, 9),
  ];
  unwrap(
    await seedRows(spine.db, {
      workspaces: [
        { id: "shop", name: "shop", kind: "single" },
        { id: "blog", name: "blog", kind: "single" },
      ],
      agents: [agent("shop-builder", "shop"), agent("blog-builder", "blog")],
      tickets: [
        ticketRow(4, { workspace_id: "shop", status: "done" }),
        ticketRow(5, { workspace_id: "blog", status: "done" }),
        ticketRow(6, { status: "code_review" }),
        ticketRow(7, { workspace_id: "shop", status: "code_review" }),
      ],
      sessions: [
        session("s-shop", "shop-builder", "ticket-4"),
        session("s-blog", "blog-builder", "ticket-5"),
      ],
      runs: costs.map((c) => c.run),
      spend: costs.map((c) => c.spend),
      gates: [
        gate("g-shop", 4, { state: "failed", started_at: 10 }),
        gate("g-shop-2", 7, { started_at: 20 }),
        gate("g-blog", 5, { state: "failed", started_at: 30 }),
        gate("g-fleet", 6, { started_at: 40 }),
      ],
      human_requests: [
        request("r1", { ticket_id: "ticket-4" }),
        request("r2", { ticket_id: "ticket-4", answered: true }),
        request("r3", { session_id: "s-shop" }),
        request("r4", { ticket_id: "ticket-5" }),
        request("r5", {}),
      ],
    }),
  );
  apiDb = unwrap(await openDb({ path: spine.path, clock: new FakeClock(NOW) }));
  api = await startApi({
    config: { token: TOKEN, host: "127.0.0.1", port: 0 },
    store: dbStore(apiDb),
    clock: systemClock,
    logger: false,
    gates: new GateService({ db: apiDb }),
  });
});

afterAll(async () => {
  await api?.close();
  await apiDb?.close();
  spine?.cleanup();
});

async function ok<T>(
  path: string,
  schema: { parse(body: unknown): T },
): Promise<T> {
  const res = await get(path);
  expect(res.status).toBe(200);
  return schema.parse(await res.json());
}

describe.each(["/gates", "/inbox", "/spend"])("GET %s?project=", (route) => {
  test("with no value is 400", async () => {
    const res = await get(`${route}?project=`);
    expect(res.status).toBe(400);
    expect(ApiErrorBody.parse(await res.json()).error.class).toBe("validation");
  });
});

describe("GET /gates?project=", () => {
  const gateIds = async (query: string) =>
    (await ok(`/gates?${query}`, GatesPage)).items.map((g) => g.id);

  test("keeps the gates of the project's tickets; another project's and a fleet ticket's never", async () => {
    expect(await gateIds("project=shop")).toEqual(["g-shop-2", "g-shop"]);
    expect(await gateIds("project=blog")).toEqual(["g-blog"]);
    expect(await gateIds("project=nowhere")).toEqual([]);
    expect(await gateIds("")).toEqual([
      "g-fleet",
      "g-blog",
      "g-shop-2",
      "g-shop",
    ]);
  });

  test("the review queue's state filter and cursor work inside the project", async () => {
    expect(await gateIds("state=running,failed&latest=1&project=shop")).toEqual(
      ["g-shop-2", "g-shop"],
    );
    expect(await gateIds("state=failed&project=shop")).toEqual(["g-shop"]);
    const first = await ok("/gates?project=shop&limit=1", GatesPage);
    expect(first.items.map((g) => g.id)).toEqual(["g-shop-2"]);
    expect(first.has_more).toBe(true);
    const next = await ok(
      `/gates?project=shop&limit=1&cursor=${first.next_cursor ?? ""}`,
      GatesPage,
    );
    expect(next.items.map((g) => g.id)).toEqual(["g-shop"]);
    expect(next.has_more).toBe(false);
  });
});

describe("GET /inbox?project=", () => {
  const requestIds = async (query: string) =>
    (await ok(`/inbox?${query}&limit=100`, InboxPage)).items.map((r) => r.id);

  test("one project's open and answered requests, by ticket, else session", async () => {
    expect(await requestIds("status=open&project=shop")).toEqual(["r3", "r1"]);
    expect(await requestIds("status=answered&project=shop")).toEqual(["r2"]);
    expect(await requestIds("status=open&project=blog")).toEqual(["r4"]);
    expect(await requestIds("status=answered&project=blog")).toEqual([]);
    expect(await requestIds("project=nowhere")).toEqual([]);
  });
});

describe("GET /spend?project=", () => {
  const report = (query: string) => ok(`/spend?${query}`, SpendReport);

  test("the summary is the project's: today and the window, the IDE's headline", async () => {
    const shop = await report("group=day&project=shop");
    expect(shop.summary.burn.today_usd).toBe(4);
    expect(shop.summary.total_usd).toBe(4);
    const blog = await report("group=day&project=blog");
    expect(blog.summary.total_usd).toBe(7);
    const fleet = await report("group=day");
    expect(fleet.summary.total_usd).toBe(4 + 7 + 9);
  });

  test("each grouping keeps the project's rows", async () => {
    const shop = await report("group=ticket&project=shop");
    expect(shop.group === "ticket" && shop.rows.map((r) => r.num)).toEqual([4]);
    const blog = await report("group=ticket&project=blog");
    expect(blog.group === "ticket" && blog.rows.map((r) => r.num)).toEqual([5]);
    const tiers = await report("group=tier&project=shop");
    expect(
      tiers.group === "tier" && tiers.rows.map((r) => r.closed_tickets),
    ).toEqual([1]);
    const classes = await report("group=class&project=shop");
    expect(
      classes.group === "class" &&
        classes.rows.map((r) => [r.run_class, r.cost_usd]),
    ).toEqual([
      ["build", 3],
      ["review", 1],
    ]);
    const days = await report("group=day&project=shop");
    expect(
      days.group === "day" && days.rows.reduce((sum, r) => sum + r.cost_usd, 0),
    ).toBe(4);
  });

  test("an unknown project is zeros and empty rows", async () => {
    const nowhere = await report("group=ticket&project=nowhere");
    expect(nowhere.summary.total_usd).toBe(0);
    expect(nowhere.rows).toEqual([]);
  });

  test.each(["day", "ticket", "tier", "class"] as const)(
    "without project, the %s body is the fleet's read, byte for byte",
    async (group: SpendGroup) => {
      const res = await get(`/spend?group=${group}`);
      expect(res.status).toBe(200);
      expect(await res.text()).toBe(
        JSON.stringify(
          SpendReport.parse(unwrap(await getSpendReport(apiDb, group))),
        ),
      );
    },
  );
});
