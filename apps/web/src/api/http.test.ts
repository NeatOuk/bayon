import { BudgetSettings, Fleet, IDEMPOTENCY_HEADER } from "@bayon/proto";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import {
  ApiRequestError,
  deleteJson,
  getJson,
  getText,
  patchJson,
  postJson,
  putJson,
} from "@/api/http";
import { fleet } from "@/test/fixtures";
import { stubFetch } from "@/test/render";

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => {
      throw new Error("expected a rejection");
    },
    (error: unknown) => error,
  );

describe("getJson", () => {
  test("returns the body parsed with the schema", async () => {
    stubFetch({ "/api/v1/fleet": fleet([]) });
    expect(await getJson("/fleet", Fleet)).toEqual(fleet([]));
  });

  test("a non-2xx carries the server's error", async () => {
    stubFetch({});
    const error = await rejection(getJson("/fleet", Fleet));
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({
      status: 404,
      error: { class: "not_found", retryable: false },
    });
  });

  test("a non-2xx without an error body says what failed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad gateway", { status: 502 })),
    );
    expect(await rejection(getJson("/fleet", Fleet))).toMatchObject({
      status: 502,
      error: { class: "internal", retryable: true },
    });
  });

  test("a body the schema rejects is a validation error, not data", async () => {
    stubFetch({ "/api/v1/fleet": { sessions: "nope" } });
    const error = await rejection(getJson("/fleet", Fleet));
    expect(error).toMatchObject({ error: { class: "validation" } });
    expect(String(error)).toContain("/fleet");
  });
});

test("getText returns the body as text", async () => {
  stubFetch({ "/api/v1/x": "plain" });
  expect(await getText("/x")).toBe("plain");
});

describe("putJson", () => {
  test("sends the body and returns the parsed response", async () => {
    const fetchMock = stubFetch({
      "/api/v1/settings/budget": { daily_cap_usd: 40 },
    });
    const result = await putJson(
      "/settings/budget",
      { daily_cap_usd: 40 },
      BudgetSettings,
    );
    expect(result).toEqual({ daily_cap_usd: 40 });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect(init?.method).toBe("PUT");
    expect(init?.body).toBe(JSON.stringify({ daily_cap_usd: 40 }));
  });

  test("a non-2xx carries the server's error", async () => {
    stubFetch({});
    const error = await rejection(
      putJson("/settings/budget", { daily_cap_usd: -1 }, BudgetSettings),
    );
    expect(error).toBeInstanceOf(ApiRequestError);
    expect(error).toMatchObject({ status: 404 });
  });
});

describe("Idempotency-Key", () => {
  test("postJson sends the key when one is given, and no header when it is not", async () => {
    const fetchMock = stubFetch({ "/api/v1/tickets/7/staff": { ok: true } });
    await postJson("/tickets/7/staff", { role: "builder" }, z.unknown(), {
      idempotencyKey: "key-1",
    });
    await postJson("/tickets/7/staff", { role: "builder" }, z.unknown());
    const headers = fetchMock.mock.calls.map(
      ([, init]) =>
        (init?.headers as Record<string, string>)[IDEMPOTENCY_HEADER],
    );
    expect(headers).toEqual(["key-1", undefined]);
  });

  test("deleteJson sends the key too: detach is a command like any other", async () => {
    const fetchMock = stubFetch({ "/api/v1/sessions/s1/attach": { ok: true } });
    await deleteJson("/sessions/s1/attach", z.unknown(), {
      idempotencyKey: "key-2",
    });
    const [, init] = fetchMock.mock.calls[0] ?? [];
    expect((init?.headers as Record<string, string>)[IDEMPOTENCY_HEADER]).toBe(
      "key-2",
    );
  });
});

// the ticket GET's ETag is its version, not a hash of the body. A browser that cached the
// body revalidated on it, got a 304 and handed back a body from before `next_step` existed. API data
// is live state: no call goes through the browser's HTTP cache.
describe("no call is served from the browser's cache", () => {
  const PATH = "/api/v1/tickets/7";
  const calls: readonly [string, (signal: AbortSignal) => Promise<unknown>][] =
    [
      ["getJson", (signal) => getJson("/tickets/7", z.unknown(), signal)],
      ["getText", (signal) => getText("/tickets/7", signal)],
      [
        "putJson",
        (signal) => putJson("/tickets/7", {}, z.unknown(), { signal }),
      ],
      [
        "postJson",
        (signal) => postJson("/tickets/7", {}, z.unknown(), { signal }),
      ],
      [
        "patchJson",
        (signal) =>
          patchJson("/tickets/7", {}, z.unknown(), { signal, version: 3 }),
      ],
      [
        "deleteJson",
        (signal) => deleteJson("/tickets/7", z.unknown(), { signal }),
      ],
    ];

  test.each(calls)(
    "%s fetches with no-store, keeping its own init",
    async (_, send) => {
      const fetchMock = stubFetch({ [PATH]: { ok: true } });
      const { signal } = new AbortController();
      await send(signal);
      const [input, init] = fetchMock.mock.calls[0] ?? [];
      expect(String(input)).toBe(PATH);
      expect(init?.cache).toBe("no-store");
      expect(init?.signal).toBe(signal);
    },
  );
});
