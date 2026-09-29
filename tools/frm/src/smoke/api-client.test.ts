import { FakeClock } from "@bayon/core";
import { IDEMPOTENCY_HEADER, type EventItem } from "@bayon/proto";
import { expect, test } from "vitest";
import {
  apiClient,
  EVENTS_MAX_PAGES,
  EVENTS_PAGE_TIMEOUT_MS,
  type Fetch,
} from "./api-client.js";

interface Seen {
  readonly url: string;
  readonly init: RequestInit;
}

/** A fetch that answers from `replies` in order and records every request. */
function fakeFetch(replies: readonly (Response | Error)[]) {
  const seen: Seen[] = [];
  let next = 0;
  const fetch: Fetch = async (url, init) => {
    seen.push({ url, init });
    const reply = replies[next++];
    if (reply === undefined) throw new Error("no reply left");
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { fetch, seen };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const BASE = "http://127.0.0.1:9/api/v1";
const client = (fetch: Fetch) =>
  apiClient({ baseUrl: BASE, token: "t".repeat(32), fetch });

test("spawn posts the body with the bearer and the Idempotency-Key", async () => {
  const f = fakeFetch([
    json({ command_id: "c1", session_id: "s1", created: true }, 202),
  ]);
  const body = {
    agent_id: "a",
    role: "builder",
    run_class: "build",
    prompt: "p",
  };
  expect(await client(f.fetch).spawn(body, "k-1")).toEqual({
    ok: true,
    value: { command_id: "c1", session_id: "s1", created: true },
  });
  const [request] = f.seen;
  expect(request?.url).toBe(`${BASE}/sessions`);
  expect(request?.init).toMatchObject({
    method: "POST",
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${"t".repeat(32)}`,
      "content-type": "application/json",
      [IDEMPOTENCY_HEADER]: "k-1",
    },
  });
});

test("transitionTicket sends If-Match with the version; pulseRunNow the agent and the key", async () => {
  const ticket = {
    id: "01T",
    key: "FRM-1",
    num: 1,
    title: "t",
    body_md: "",
    acceptance_md: "",
    type: "docs",
    status: "prioritized",
    priority: 0,
    needs_human: false,
    open_questions: 0,
    non_trivial: false,
    complexity_score: 0,
    complexity_tier: "simple",
    complexity_factors: null,
    workspace_id: null,
    epic_id: null,
    parent_ticket_id: null,
    origin: "operator",
    origin_ref: null,
    blocked_reason: null,
    unblock_condition: null,
    owner_session_id: null,
    branch: null,
    plan_path: null,
    pr_url: null,
    split_depth: 0,
    children_total: 0,
    children_done: 0,
    version: 4,
    created_at: 1,
    updated_at: 2,
    closed_at: null,
  };
  const f = fakeFetch([
    json(ticket),
    json({ command_id: "c2", created: true }, 202),
  ]);
  const api = client(f.fetch);
  const moved = await api.transitionTicket("FRM-1", 3, { to: "prioritized" });
  expect(moved.ok ? null : moved.error).toBeNull();
  expect(await api.pulseRunNow("orch", "k-2")).toEqual({
    ok: true,
    value: { command_id: "c2", created: true },
  });
  expect(f.seen.map((s) => s.url)).toEqual([
    `${BASE}/tickets/FRM-1/transition`,
    `${BASE}/pulses/run-now`,
  ]);
  expect(f.seen[0]?.init).toMatchObject({
    method: "POST",
    body: JSON.stringify({ to: "prioritized" }),
    headers: { "if-match": '"3"' },
  });
  expect(f.seen[1]?.init).toMatchObject({
    body: JSON.stringify({ agent_id: "orch" }),
    headers: { [IDEMPOTENCY_HEADER]: "k-2" },
  });
});

test("an error body keeps its class; the message names the call", async () => {
  const f = fakeFetch([
    json(
      {
        error: {
          class: "not_found",
          message: "session s9 does not exist",
          retryable: false,
        },
      },
      404,
    ),
    new Response("gateway down", { status: 502 }),
    new Error("ECONNREFUSED"),
  ]);
  const api = client(f.fetch);
  expect(await api.session("s9")).toEqual({
    ok: false,
    error: {
      class: "not_found",
      message: "GET /sessions/s9: session s9 does not exist",
      retryable: false,
      cause: { status: 404 },
    },
  });
  expect(await api.command("c1")).toMatchObject({
    ok: false,
    error: {
      class: "internal",
      message: "GET /commands/c1: HTTP 502",
      cause: { status: 502 },
    },
  });
  expect(await api.health()).toMatchObject({
    ok: false,
    error: {
      class: "internal",
      retryable: true,
      message: "GET /health: ECONNREFUSED",
    },
  });
});

test("a reply that does not match its DTO is a validation error", async () => {
  const f = fakeFetch([json({ status: "degraded" })]);
  const health = await client(f.fetch).health();
  expect(health.ok ? null : health.error).toMatchObject({
    class: "validation",
  });
});

const event = (id: number): EventItem => ({
  id,
  kind: "turn_start",
  ts: 1,
  runner_type: "smoke.step",
  payload: {},
});

test("events pages through has_more from next_cursor", async () => {
  const f = fakeFetch([
    json({ items: [event(1), event(2)], next_cursor: 2, has_more: true }),
    json({ items: [event(3)], next_cursor: 3, has_more: false }),
  ]);
  const events = await client(f.fetch).events("s1");
  expect(events.ok && events.value.map((e) => e.id)).toEqual([1, 2, 3]);
  expect(f.seen.map((s) => s.url)).toEqual([
    `${BASE}/sessions/s1/events?since=0&limit=1000`,
    `${BASE}/sessions/s1/events?since=2&limit=1000`,
  ]);
});

test("events gives up with a targeted message if has_more never turns false", async () => {
  const replies = Array.from({ length: EVENTS_MAX_PAGES + 5 }, (_, i) =>
    json({ items: [event(i + 1)], next_cursor: i + 1, has_more: true }),
  );
  const f = fakeFetch(replies);
  const result = await client(f.fetch).events("s1");
  expect(result).toMatchObject({
    ok: false,
    error: {
      class: "internal",
      message: `GET /sessions/s1/events: still has_more after ${EVENTS_MAX_PAGES} pages; the API may be stuck paginating`,
    },
  });
  // Bounded: it stopped at the cap instead of following has_more forever.
  expect(f.seen.length).toBe(EVENTS_MAX_PAGES);
});

test("a page that never answers fails at its own deadline, not by hanging forever", async () => {
  const clock = new FakeClock(0);
  const stuck: Fetch = () => new Promise(() => {}); // never resolves
  const done = apiClient({
    baseUrl: BASE,
    token: "t".repeat(32),
    fetch: stuck,
    clock,
  }).events("s1");
  // One event-loop turn first, so the race has armed its timer.
  await new Promise((resolve) => setImmediate(resolve));
  await clock.advance(EVENTS_PAGE_TIMEOUT_MS);
  expect(await done).toMatchObject({
    ok: false,
    error: {
      class: "timeout",
      message: `GET /sessions/s1/events (page 1): not within ${EVENTS_PAGE_TIMEOUT_MS / 1_000} s`,
    },
  });
});

/** A valid TicketView: what POST /tickets answers for a new backlog ticket. */
const TICKET = {
  id: "01TICKETA",
  key: "T-1",
  num: 1,
  title: "A",
  body_md: "",
  acceptance_md: "",
  type: "feature",
  status: "backlog",
  priority: 3,
  needs_human: false,
  open_questions: 0,
  non_trivial: false,
  complexity_score: 0,
  complexity_tier: "trivial",
  complexity_factors: null,
  workspace_id: null,
  epic_id: null,
  parent_ticket_id: null,
  origin: "operator",
  origin_ref: null,
  blocked_reason: null,
  unblock_condition: null,
  owner_session_id: null,
  branch: null,
  plan_path: null,
  pr_url: null,
  split_depth: 0,
  children_total: 0,
  children_done: 0,
  version: 1,
  created_at: 1,
  updated_at: 1,
  closed_at: null,
};

test("createTicket posts to /tickets as the operator and parses the new ticket", async () => {
  const f = fakeFetch([
    json(TICKET, 201),
    json(
      {
        error: {
          class: "validation",
          message: "title: too short",
          retryable: false,
        },
      },
      400,
    ),
  ]);
  const body = { title: "A", type: "feature" as const };
  const api = client(f.fetch);
  expect(await api.createTicket(body)).toEqual({ ok: true, value: TICKET });
  expect(f.seen[0]?.url).toBe(`${BASE}/tickets`);
  expect(f.seen[0]?.init).toMatchObject({
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(await api.createTicket(body)).toMatchObject({
    ok: false,
    error: { class: "validation", message: "POST /tickets: title: too short" },
  });
});

test("exportsRun posts to /exports/run with the Idempotency-Key and parses the accepted command", async () => {
  const f = fakeFetch([json({ command_id: "c9", created: true }, 202)]);
  expect(await client(f.fetch).exportsRun("k-9")).toEqual({
    ok: true,
    value: { command_id: "c9", created: true },
  });
  expect(f.seen[0]?.url).toBe(`${BASE}/exports/run`);
  expect(f.seen[0]?.init).toMatchObject({
    method: "POST",
    headers: { [IDEMPOTENCY_HEADER]: "k-9" },
  });
});

test("saveMission posts to /missions/:agent and parses the saved version", async () => {
  const text = { who_md: "w", what_md: "wh", how_md: "h", laws_md: "l" };
  const saved = {
    id: "m1",
    agent_name: "smoke build",
    version: 1,
    ...text,
    rendered_md: "# r\n",
    hash: "a".repeat(64),
    note: "n",
    created_at: 1,
    created_by: "operator",
  };
  const body = { ...text, note: "n", base_version: 0 };
  const f = fakeFetch([
    json(saved, 201),
    json(
      {
        error: {
          class: "conflict",
          message: "stale",
          retryable: false,
          current_version: 1,
        },
      },
      409,
    ),
  ]);
  const api = client(f.fetch);
  expect(await api.saveMission("smoke build", body)).toEqual({
    ok: true,
    value: saved,
  });
  expect(f.seen[0]?.url).toBe(`${BASE}/missions/smoke%20build`);
  expect(f.seen[0]?.init).toMatchObject({
    method: "POST",
    body: JSON.stringify(body),
  });
  expect(await api.saveMission("smoke build", body)).toMatchObject({
    ok: false,
    error: {
      class: "conflict",
      message: "POST /missions/smoke%20build: stale",
    },
  });
});
