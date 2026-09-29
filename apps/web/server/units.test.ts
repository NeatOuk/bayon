import { PassThrough } from "node:stream";
import { FakeClock } from "@bayon/core";
import { describe, expect, test } from "vitest";
import {
  clearSessionCookie,
  sessionCookieValues,
  setSessionCookie,
} from "./cookies.js";
import { hashFromInput } from "./hash-password.js";
import { mayAct } from "./origin-guard.js";
import { hashPassword, parsePasswordHash, verifyPassword } from "./password.js";
import { LoginLimiter, LOGIN_LIMITS, MAX_TRACKED } from "./rate-limit.js";
import { SessionStore, type WsPair } from "./sessions.js";

// The edge server's parts: the guard, the password, the cookie, the sessions
// and the login limits, each on its own. edge.test.ts runs them together over HTTP.
const ORIGINS = new Set(["http://gui.test:5173"]);
const PASSWORD = "correct-horse-battery-staple-42";

describe("mayAct (the production guard)", () => {
  const own = {
    origin: "http://gui.test:5173",
    "sec-fetch-site": "same-origin",
  };
  test("every request needs a sign from the page; an unsafe one or an upgrade needs the Origin itself", () => {
    const any = { requireOrigin: false };
    // Neither header: no sign it came from the page (security review), refused even for a GET.
    expect(mayAct("GET", {}, ORIGINS, any)).toBe(false);
    expect(
      mayAct("GET", { "sec-fetch-site": "same-origin" }, ORIGINS, any),
    ).toBe(true);
    expect(
      mayAct("GET", { origin: "http://gui.test:5173" }, ORIGINS, any),
    ).toBe(true);
    expect(
      mayAct("POST", { "sec-fetch-site": "same-origin" }, ORIGINS, any),
    ).toBe(false);
    expect(mayAct("POST", {}, ORIGINS, any)).toBe(false);
    expect(mayAct("GET", {}, ORIGINS, { requireOrigin: true })).toBe(false);
    expect(mayAct("POST", own, ORIGINS, any)).toBe(true);
    expect(mayAct("GET", own, ORIGINS, { requireOrigin: true })).toBe(true);
  });

  test("same-site (another port on this IP) and a foreign Origin are refused", () => {
    expect(
      mayAct(
        "GET",
        { origin: "http://gui.test:3001", "sec-fetch-site": "same-site" },
        ORIGINS,
        { requireOrigin: false },
      ),
    ).toBe(false);
    expect(
      mayAct("DELETE", { origin: "http://gui.test:3001" }, ORIGINS, {
        requireOrigin: false,
      }),
    ).toBe(false);
  });
});

describe("LoginLimiter memory (security review)", () => {
  test("sweep forgets addresses whose failures left the window", async () => {
    const clock = new FakeClock(0);
    const limiter = new LoginLimiter(clock);
    limiter.failed("a");
    limiter.failed("b");
    expect(limiter.tracked).toBe(2);
    await clock.advance(LOGIN_LIMITS.addressWindowMs);
    limiter.sweep();
    expect(limiter.tracked).toBe(0);
  });

  test("at most MAX_TRACKED addresses are remembered; the oldest go first", async () => {
    const clock = new FakeClock(0);
    const limiter = new LoginLimiter(clock);
    for (let i = 0; i < MAX_TRACKED + 10; i += 1) {
      await clock.advance(1);
      limiter.failed(`x${i}`);
    }
    expect(limiter.tracked).toBe(MAX_TRACKED);
    // x0 was forgotten, so its count starts over; the newest address still has its failure.
    expect(limiter.admit("x0").ok).toBe(true);
  });
});

describe("password", () => {
  test("hash, parse and verify round-trip; a wrong password fails", async () => {
    const stored = parsePasswordHash(
      await hashPassword(PASSWORD, { logN: 14 }),
    );
    if (!stored.ok) throw new Error(stored.error.message);
    expect(await verifyPassword(stored.value, PASSWORD)).toBe(true);
    expect(await verifyPassword(stored.value, `${PASSWORD}x`)).toBe(false);
    expect(await verifyPassword(stored.value, "x".repeat(2000))).toBe(false);
  });

  test("the default cost is log N 15, and the stored form never holds the password", async () => {
    const text = await hashPassword(PASSWORD);
    expect(text).toMatch(/^scrypt\$15\$8\$1\$/);
    expect(text).not.toContain(PASSWORD);
  });

  test.each([
    "plain",
    "scrypt$10$8$1$c2FsdHNhbHRzYWx0c2FsdA==$aGFzaA==",
    "scrypt$15$8$1$c2hvcnQ=$" + "A".repeat(88),
  ])("refuses a malformed or weak stored form: %s", (text) => {
    expect(parsePasswordHash(text)).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
  });
});

describe("hashFromInput (hash-password)", () => {
  test("strips one LF or CR LF, and a stray CR", async () => {
    for (const input of [`${PASSWORD}\n`, `${PASSWORD}\r\n`, `${PASSWORD}\r`]) {
      const hashed = await hashFromInput(input, { logN: 14 });
      if (!hashed.ok) throw new Error(hashed.error.message);
      const stored = parsePasswordHash(hashed.value);
      if (!stored.ok) throw new Error(stored.error.message);
      expect(await verifyPassword(stored.value, PASSWORD)).toBe(true);
    }
  });

  test("refuses under 20 characters, and more than one line", async () => {
    expect((await hashFromInput("short-password\n")).ok).toBe(false);
    expect((await hashFromInput(`${PASSWORD}\n${PASSWORD}\n`)).ok).toBe(false);
  });
});

describe("cookies", () => {
  const value = "A".repeat(43);
  test("every well-formed frm_session value, duplicates included", () => {
    expect(
      sessionCookieValues(
        `other=1; frm_session=${value}; frm_session=bad; frm_session=${"B".repeat(43)}`,
      ),
    ).toEqual([value, "B".repeat(43)]);
    expect(sessionCookieValues(undefined)).toEqual([]);
  });

  test("HttpOnly, SameSite=Strict, Path=/ and no Max-Age: a browser-session cookie", () => {
    const set = setSessionCookie(value);
    expect(set).toBe(`frm_session=${value}; HttpOnly; SameSite=Strict; Path=/`);
    expect(set).not.toMatch(/Max-Age|Expires/i);
    expect(clearSessionCookie()).toMatch(/Max-Age=0/);
  });
});

describe("SessionStore", () => {
  const limits = { absoluteMs: 10_000, idleMs: 4_000, max: 2 };

  test("bound to its address: another address finds nothing and does not end it", () => {
    const store = new SessionStore(new FakeClock(0), limits);
    const value = store.create("10.0.0.1");
    expect(store.find([value], "10.0.0.2")).toBeNull();
    expect(store.find([value], "10.0.0.1")).not.toBeNull();
  });

  test("idle and absolute expiry end a session", async () => {
    const clock = new FakeClock(0);
    const ended: string[] = [];
    const store = new SessionStore(clock, limits, (_a, why) => ended.push(why));
    const value = store.create("a");
    await clock.advance(3_000);
    expect(store.find([value], "a")).not.toBeNull();
    await clock.advance(3_000);
    expect(store.find([value], "a")).not.toBeNull();
    await clock.advance(4_000);
    expect(store.find([value], "a")).toBeNull();
    expect(ended).toEqual(["expired"]);
  });

  test("at most `max`: the oldest is evicted", () => {
    const store = new SessionStore(new FakeClock(0), limits);
    const first = store.create("a");
    store.create("a");
    store.create("a");
    expect(store.size).toBe(2);
    expect(store.find([first], "a")).toBeNull();
  });

  test("ending a session writes a 4401 close frame to its sockets", () => {
    const store = new SessionStore(new FakeClock(0), limits);
    const key = store.find([store.create("a")], "a");
    if (key === null) throw new Error("no session");
    const client = new PassThrough();
    const upstream = new PassThrough();
    const chunks: Buffer[] = [];
    client.on("data", (chunk: Buffer) => chunks.push(chunk));
    const pair: WsPair = { client, upstream };
    store.attach(key, pair);
    store.end(key, "logout");
    const frame = Buffer.concat(chunks);
    expect(frame[0]).toBe(0x88);
    expect(frame.readUInt16BE(2)).toBe(4401);
    expect(upstream.destroyed).toBe(true);
  });
});

describe("LoginLimiter", () => {
  test("five failures from one address close it; another address still gets in", () => {
    const clock = new FakeClock(0);
    const limiter = new LoginLimiter(clock, {
      ...LOGIN_LIMITS,
      globalIntervalMs: 0,
    });
    for (let i = 0; i < 5; i += 1) {
      const a = limiter.admit("a");
      if (!a.ok) throw new Error("refused too early");
      limiter.failed("a");
      a.release();
    }
    expect(limiter.admit("a")).toMatchObject({ ok: false, why: "address" });
    expect(limiter.admit("b")).toMatchObject({ ok: true });
  });

  test("the address window rolls, and a success clears the count", async () => {
    const clock = new FakeClock(0);
    const limiter = new LoginLimiter(clock, {
      ...LOGIN_LIMITS,
      globalIntervalMs: 0,
    });
    for (let i = 0; i < 5; i += 1) limiter.failed("a");
    const refused = limiter.admit("a");
    expect(refused).toMatchObject({
      ok: false,
      why: "address",
      retryAfterSec: 900,
    });
    await clock.advance(15 * 60_000);
    expect(limiter.admit("a").ok).toBe(true);
    for (let i = 0; i < 4; i += 1) limiter.failed("b");
    limiter.succeeded("b");
    limiter.failed("b");
    expect(limiter.admit("b").ok).toBe(true);
  });

  test("one attempt a second across every address, never a lockout", async () => {
    const clock = new FakeClock(0);
    const limiter = new LoginLimiter(clock);
    const first = limiter.admit("a");
    expect(first.ok).toBe(true);
    expect(limiter.admit("b")).toMatchObject({
      ok: false,
      why: "rate",
      retryAfterSec: 1,
    });
    await clock.advance(1_000);
    expect(limiter.admit("b").ok).toBe(true);
  });

  test("at most two scrypt computations at once", () => {
    const limiter = new LoginLimiter(new FakeClock(0), {
      ...LOGIN_LIMITS,
      globalIntervalMs: 0,
    });
    const one = limiter.admit("a");
    const two = limiter.admit("b");
    expect(limiter.admit("c")).toMatchObject({ ok: false, why: "busy" });
    if (!one.ok || !two.ok) throw new Error("refused");
    one.release();
    one.release();
    expect(limiter.admit("c").ok).toBe(true);
  });

  test("sustained failures warn once a minute", async () => {
    const clock = new FakeClock(0);
    const warnings: string[] = [];
    const limiter = new LoginLimiter(clock, LOGIN_LIMITS, (msg) =>
      warnings.push(msg),
    );
    for (let i = 0; i < 25; i += 1) limiter.failed(`a${i}`);
    expect(warnings).toEqual(["repeated failed logins"]);
    await clock.advance(60_000);
    for (let i = 0; i < 10; i += 1) limiter.failed(`b${i}`);
    expect(warnings).toHaveLength(2);
  });
});
