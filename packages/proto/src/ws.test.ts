import { describe, expect, test } from "vitest";
import {
  ClientFrame,
  ServerFrame,
  frameCursor,
  parseTopic,
  sessionEventsTopic,
} from "./ws.js";

const omit = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => k !== key));

const event = (id: number) => ({
  id,
  kind: "assistant_text",
  ts: 1_000 + id,
  runner_type: "text",
  text: `hello ${id}`,
  payload: {},
});

const ticketEvent = (id: number) => ({
  id,
  ticket_id: "T1",
  ts: 1_000 + id,
  actor_kind: "operator",
  actor_id: "operator",
  kind: "transition",
  from_status: "backlog",
  to_status: "prioritized",
  reason: null,
  payload: { rule: "prioritize" },
});

describe("topics", () => {
  test("fleet, tickets, spend, inbox, pulses, gates and session:<id>:events are the only topics", () => {
    expect(parseTopic("fleet")).toEqual({ kind: "fleet" });
    expect(parseTopic("tickets")).toEqual({ kind: "tickets" });
    expect(parseTopic("spend")).toEqual({ kind: "spend" });
    expect(parseTopic("pulses")).toEqual({ kind: "pulses" });
    expect(parseTopic("gates")).toEqual({ kind: "gates" });
    expect(parseTopic("spend:day")).toBeNull();
    expect(parseTopic("inbox")).toEqual({ kind: "inbox" });
    expect(parseTopic("inbox:1")).toBeNull();
    expect(parseTopic("session:01J0ABC:events")).toEqual({
      kind: "session_events",
      sessionId: "01J0ABC",
    });
    for (const bad of [
      "tickets:1",
      "tickets ",
      "gates:1",
      "approvals",
      "pulses:1",
      "session::events",
      "session:a:b:events",
      "session:a:pty",
      "session:a b:events",
      "fleet ",
      "",
    ]) {
      expect(parseTopic(bad)).toBeNull();
    }
  });

  test("sessionEventsTopic builds a topic parseTopic accepts", () => {
    const topic = sessionEventsTopic("01J0ABC");
    expect(topic).toBe("session:01J0ABC:events");
    expect(parseTopic(topic)).toEqual({
      kind: "session_events",
      sessionId: "01J0ABC",
    });
  });
});

describe("client frames", () => {
  test("subscribe takes an optional non-negative integer since", () => {
    expect(ClientFrame.parse({ type: "subscribe", topic: "fleet" })).toEqual({
      type: "subscribe",
      topic: "fleet",
    });
    expect(
      ClientFrame.parse({ type: "subscribe", topic: "fleet", since: 7 }),
    ).toEqual({ type: "subscribe", topic: "fleet", since: 7 });
    for (const since of [-1, 1.5, "3"]) {
      expect(
        ClientFrame.safeParse({ type: "subscribe", topic: "fleet", since })
          .success,
      ).toBe(false);
    }
  });

  test("unsubscribe names a topic; other types are rejected", () => {
    expect(ClientFrame.parse({ type: "unsubscribe", topic: "fleet" })).toEqual({
      type: "unsubscribe",
      topic: "fleet",
    });
    expect(ClientFrame.safeParse({ type: "publish", topic: "x" }).success).toBe(
      false,
    );
  });
});

describe("server frames", () => {
  test("an events frame carries canonical events with their ids", () => {
    const frame = {
      type: "events",
      topic: "session:S1:events",
      cursor: 2,
      items: [event(1), event(2)],
    };
    expect(ServerFrame.parse(frame)).toEqual(frame);
  });

  test("an event without an id or with an unknown kind is rejected", () => {
    for (const item of [
      omit(event(1), "id"),
      { ...event(1), kind: "mystery" },
    ]) {
      const frame = {
        type: "events",
        topic: "session:S1:events",
        cursor: 1,
        items: [item],
      };
      expect(ServerFrame.safeParse(frame).success).toBe(false);
    }
  });

  test("a ticket_events frame carries ticket events on the tickets topic (contract 8)", () => {
    const frame = {
      type: "ticket_events",
      topic: "tickets",
      cursor: 2,
      items: [ticketEvent(1), ticketEvent(2)],
    };
    expect(ServerFrame.parse(frame)).toEqual(frame);
    expect(ServerFrame.safeParse({ ...frame, topic: "fleet" }).success).toBe(
      false,
    );
    expect(
      ServerFrame.safeParse({ ...frame, items: [omit(ticketEvent(1), "id")] })
        .success,
    ).toBe(false);
  });

  test("a spend frame carries the summary on the spend topic (§8.9)", () => {
    const quiet = {
      daily_usd: 0,
      baseline_daily_usd: null,
      change_pct: null,
      alarm: false,
      drop: false,
    };
    const frame = {
      type: "spend",
      topic: "spend",
      cursor: 1_000,
      data: {
        window: { from: 0, to: 1_000 },
        total_usd: 0,
        wasted_usd: 0,
        waste_pct: null,
        burn: { today_usd: 0, month_to_date_usd: 0, projected_month_usd: 0 },
        alarm: {
          threshold_pct: 25,
          baseline_days: 30,
          last_day: quiet,
          last_7d: quiet,
          active: false,
          paused: false,
          dropped: false,
        },
      },
    };
    expect(ServerFrame.parse(frame)).toEqual(frame);
    expect(ServerFrame.safeParse({ ...frame, topic: "fleet" }).success).toBe(
      false,
    );
    expect(ServerFrame.safeParse(omit(frame, "cursor")).success).toBe(false);
  });

  test("fleet, resync and error frames all carry a cursor", () => {
    const fleet = {
      type: "fleet",
      topic: "fleet",
      cursor: 1_000,
      data: {
        paused: false,
        sessions: [],
        budget: { today_usd: 0, daily_cap_usd: null },
        budgets: [],
        slots: [],
        attention: [],
        disk: [],
        admission: { queued: [], by_reason: {} },
        backup: { last: null, last_ok_at: null },
        runner_updates: [],
      },
    };
    const resync = { type: "resync", topic: "session:S1:events", cursor: 9 };
    const error = {
      type: "error",
      topic: "pulses",
      cursor: 0,
      error: {
        class: "validation",
        message: "unknown topic",
        retryable: false,
      },
    };
    for (const frame of [fleet, resync, error]) {
      expect(ServerFrame.parse(frame)).toEqual(frame);
      expect(ServerFrame.safeParse(omit(frame, "cursor")).success).toBe(false);
    }
  });
});

describe("cursor rule", () => {
  test("a frame's cursor is its last item id, or since when it has none", () => {
    expect(frameCursor([event(4), event(9)], 3)).toBe(9);
    expect(frameCursor([], 3)).toBe(3);
  });
});
