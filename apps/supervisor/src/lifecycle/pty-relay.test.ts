// session:<id>:pty end to end (§12.5 point 3): a real tmux/pty under a real
// LocalExecutor, streamed over a real relay socket to a raw client — the exact seam
// review flagged as the one a mock must never hide. Output flowing supervisor->client
// and a heartbeat actually renewing the DB lease are both directly observable; the fixture runner's
// interactive stand-in never reads its stdin meaningfully, so input is exercised for
// "doesn't crash the pipe", not for an observable echo.
import { createConnection, type Socket } from "node:net";
import { mkdir, readFile } from "node:fs/promises";
import {
  FakeClock,
  RelayFrameDecoder,
  encodeRelayFrame,
  ok,
  type RelayFrame,
} from "@bayon/core";
import {
  encodePtyData,
  encodePtyHeartbeat,
  encodePtyResize,
} from "@bayon/proto";
import { tempDb, seedRows, unwrap } from "@bayon/db/testing";
import { LocalExecutor, SlotCounter } from "@bayon/executors";
import {
  createFixtureAdapter,
  FIXTURE_CAPS,
  type FixtureScriptInput,
} from "@bayon/runners/fixture";
import { pino } from "pino";
import { afterAll, describe, expect, test, vi } from "vitest";
import { MIN_HEAD, REDACTED } from "../ingest/redact.js";
import { openRelayServer } from "../relay.js";
import { ptyLogWriter } from "./pty-relay.js";
import {
  CMD,
  EXECUTOR_ID,
  startLifecycle,
  tempHome,
} from "./testing/fixtures.js";
import {
  TE as TURN_END,
  TS as TURN_START,
  capturing,
  makeRepo,
  session,
  spawnOn,
  waitState,
  worldRows,
} from "./testing/handoff-world.js";

vi.setConfig({ testTimeout: 30_000 });

const T0 = 1_700_000_000_000;
const SCRIPT: FixtureScriptInput = {
  runs: [{ events: [TURN_START, TURN_END] }],
};
const log = pino({ level: "silent" });

// A token-shaped secret wider than the pty's 80-column pane (DEFAULT_COLS, pty-relay.ts), so tmux
// draws it over three rows. The takeover's stand-in prints its first SPLIT characters, then the rest
// only on a keystroke the test sends once it has seen that first part arrive: the value is split
// across two chunks of the real pty by construction, not by timing. redact.test.ts owns the
// split-at-every-offset guarantee; this pins the wiring against real tmux output.
const SECRET_NAME = "PTY_TEST_TOKEN";
const SECRET_VALUE = Array.from(
  { length: 190 },
  (_, i) =>
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789"[i % 62],
).join("");
const SPLIT = 100; // mid-row: the second of the value's three rows
const PRINTED = "printed:end";

/** No `MIN_HEAD`-or-more-character run of the secret survives in `text`. */
function holdsNoPieceOfSecret(text: string, value = SECRET_VALUE): void {
  for (let n = 0; n + MIN_HEAD <= value.length; n += 1) {
    expect(text).not.toContain(value.slice(n, n + MIN_HEAD));
  }
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups) await cleanup();
});

/** A tiny raw client for driving the wire protocol directly (mirrors relay.test.ts's own). */
function rawClient(path: string): {
  conn: Socket;
  send(frame: RelayFrame): void;
  next(): Promise<RelayFrame>;
} {
  const conn = createConnection(path);
  const decoder = new RelayFrameDecoder();
  const frames: RelayFrame[] = [];
  const waiters: ((frame: RelayFrame) => void)[] = [];
  conn.on("data", (chunk: Buffer) => {
    for (const step of decoder.push(chunk)) {
      if (!step.ok) throw new Error(step.message);
      const waiter = waiters.shift();
      if (waiter) waiter(step.frame);
      else frames.push(step.frame);
    }
  });
  return {
    conn,
    send: (frame) => conn.write(encodeRelayFrame(frame)),
    next: () =>
      new Promise((resolve) => {
        const already = frames.shift();
        if (already !== undefined) {
          resolve(already);
          return;
        }
        waiters.push(resolve);
      }),
  };
}

const connected = (conn: Socket): Promise<void> =>
  new Promise((resolve) => conn.once("connect", () => resolve()));

/** Appends `client`'s data frames to `seen` until `text` appears in them. Bounded, so a wire
 * regression fails naming what did arrive rather than hanging until the suite's own timeout. */
async function readUntil(
  client: ReturnType<typeof rawClient>,
  seen: Buffer,
  text: string,
): Promise<Buffer> {
  const deadline = Date.now() + 10_000;
  let out = seen;
  while (!out.toString("utf8").includes(text)) {
    const remaining = deadline - Date.now();
    let timer: NodeJS.Timeout | undefined;
    const frame = await Promise.race([
      client.next(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), Math.max(0, remaining));
      }),
    ]);
    clearTimeout(timer);
    if (frame === undefined) {
      throw new Error(
        `${JSON.stringify(text)} never arrived over the relay within 10s; saw ${out.length} bytes, tail: ${JSON.stringify(out.toString("utf8").slice(-200))}`,
      );
    }
    if (frame.type === "data") out = Buffer.concat([out, frame.payload]);
  }
  return out;
}

/** `prints` has the fixture's interactive stand-in print a value (after `resumed <rsid>`) in two
 * parts, the first `split` characters and then the rest on a keystroke — raw mode, so the keystroke
 * is not echoed between them — so the redaction tests below exercise a real value split across
 * chunks of a real tmux pane. `secret`: seeds the profile with `SECRET_NAME` as a required secret
 * ref, gives it to the world's host store, and prints that. `token`: prints the MCP token the
 * automated process was spawned with, as a resumed CLI can from its own history; `spawnToken()` and
 * `resumeToken()` name the spawn's and the resume spec's. */
async function setup(o: { prints?: "secret" | "token"; split?: number } = {}) {
  const clock = new FakeClock(T0);
  const t = unwrap(await tempDb(clock));
  const home = tempHome("frm-ptyrelay-");
  const { src, mirror } = makeRepo(home.path);
  const rows = worldRows({
    script: SCRIPT,
    src,
    mirror,
    ...(o.prints === "secret" ? { secretRefs: [SECRET_NAME] } : {}),
  });
  const runner = rows.runners[0];
  if (runner === undefined) throw new Error("worldRows seeded no runner");
  runner.caps_json = JSON.stringify({ ...FIXTURE_CAPS, pty: true });
  unwrap(await seedRows(t.db, rows));
  const slots = new SlotCounter(4);
  const executor = new LocalExecutor({ id: EXECUTOR_ID, slots });
  const base = createFixtureAdapter({ clock });
  const split = o.split ?? SPLIT;
  let spawnToken: string | undefined;
  let resumeToken: string | undefined;
  const fixture = capturing({
    ...base,
    caps: () => ({ ...base.caps(), pty: true }),
    spawn: async (spec, ex) => {
      spawnToken = spec.mcp?.token;
      return base.spawn(spec, ex);
    },
    ...(o.prints === undefined
      ? {}
      : {
          interactiveResume: async (spec, rsid, ex) => {
            resumeToken = spec.mcp?.token;
            const real = await base.interactiveResume(spec, rsid, ex);
            if (!real.ok) return real;
            const print = [
              "if (process.stdin.isTTY) process.stdin.setRawMode(true);",
              `process.stdout.write(${JSON.stringify(`resumed ${rsid}\n`)});`,
              `const v = process.env[${JSON.stringify(SECRET_NAME)}] ?? "";`,
              `process.stdout.write(v.slice(0, ${split}));`,
              `process.stdin.once("data", () => process.stdout.write(v.slice(${split}) + ${JSON.stringify(`\n${PRINTED}\n`)}));`,
              "process.stdin.resume();",
            ].join("");
            return ok({
              ...real.value,
              argv: [process.execPath, "-e", print],
              ...(o.prints === "token"
                ? {
                    env: { ...real.value.env, [SECRET_NAME]: spawnToken ?? "" },
                  }
                : {}),
            });
          },
        }),
  });
  const relay = unwrap(
    await openRelayServer({ path: `${home.path}/relay.sock`, log }),
  );
  const started = await startLifecycle({
    db: t.db,
    clock,
    frmHome: home.path,
    executor,
    slots,
    adapter: fixture.adapter,
    relay,
    ...(o.prints === "secret"
      ? { secrets: { [`FRM_SECRET_${SECRET_NAME}`]: SECRET_VALUE } }
      : {}),
  });
  cleanups.push(async () => {
    await started.lifecycle.shutdown();
    await relay.close();
    t.cleanup();
    home.cleanup();
  });
  return {
    ...started,
    db: t.db,
    clock,
    executor,
    slots,
    src,
    mirror,
    release: fixture.release,
    adopts: fixture.adopts,
    stops: fixture.stops,
    relay,
    home: home.path,
    spawnToken: () => spawnToken,
    resumeToken: () => resumeToken,
  };
}

describe("ptyLogWriter", () => {
  const TOKEN = "tok_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_ab"; // >= MIN_REDACT_LENGTH

  function tempLogPath(prefix = "frm-ptylogwriter-"): string {
    const home = tempHome(prefix);
    cleanups.push(async () => home.cleanup());
    return `${home.path}/pty.log`;
  }

  test("a chunk holding a secret is written as [redacted], not the secret", async () => {
    const path = tempLogPath();
    const w = ptyLogWriter(path, [TOKEN]);
    await w.write(`before ${TOKEN} after`);
    await w.end();
    expect(await readFile(path, "utf8")).toBe(`before ${REDACTED} after`);
  });

  test("a secret split across two writes never survives, checked after either write", async () => {
    const path = tempLogPath();
    const w = ptyLogWriter(path, [TOKEN]);
    await w.write(`env: ${TOKEN.slice(0, 10)}`);
    holdsNoPieceOfSecret(await readFile(path, "utf8").catch(() => ""), TOKEN);
    await w.write(`${TOKEN.slice(10)} :end`);
    await w.end();
    const logged = await readFile(path, "utf8");
    holdsNoPieceOfSecret(logged, TOKEN);
    expect(logged).toContain(REDACTED);
  });

  test("the ring-buffer cap still holds with redaction active", async () => {
    const path = tempLogPath();
    const w = ptyLogWriter(path, [TOKEN], 100);
    for (let i = 0; i < 20; i += 1)
      await w.write(`line-${i}-${TOKEN}-0123456789\n`);
    await w.end();
    const logged = await readFile(path, "utf8");
    expect(logged.length).toBeLessThanOrEqual(100);
    expect(logged).toContain("line-19");
    expect(logged).not.toContain(TOKEN);
  });

  test("with a token listed, ordinary output reaches the file whole: a held tail is late, never lost", async () => {
    const path = tempLogPath();
    const w = ptyLogWriter(path, [TOKEN]);
    // "ABC" and "tok" occur in TOKEN, so each chunk end is held until more arrives or end().
    const chunks = ["$ make build\r\n", "step ABC", "D done\r\n$ tok"];
    let sent = "";
    for (const c of chunks) {
      await w.write(c);
      sent += c;
      const logged = await readFile(path, "utf8").catch(() => "");
      expect(sent.startsWith(logged)).toBe(true);
    }
    await w.end();
    expect(await readFile(path, "utf8")).toBe(chunks.join(""));
  });

  test("an empty redaction list writes the file byte-identical to today's code", async () => {
    const path = tempLogPath();
    const w = ptyLogWriter(path, []);
    const chunks = ["first chunk\n", "second chunk\n", "third\n"];
    for (const c of chunks) await w.write(c);
    await w.end();
    expect(await readFile(path, "utf8")).toBe(chunks.join(""));
  });

  test("a path that cannot be written swallows the failure (scrollback is best-effort)", async () => {
    const home = tempHome("frm-ptylogwriter-badpath-");
    cleanups.push(async () => home.cleanup());
    const inTheWay = `${home.path}/not-a-file`;
    await mkdir(inTheWay, { recursive: true });
    const w = ptyLogWriter(inTheWay, [TOKEN]);
    await expect(w.write(`hello ${TOKEN}`)).resolves.toBeUndefined();
    await expect(w.end()).resolves.toBeUndefined();
  });
});

describe("session:<id>:pty over the relay", () => {
  test("a session's pty output streams to a real relay client, persists to pty_log_path, and a heartbeat renews the lease", async () => {
    const w = await setup();
    const id = "s-ptyrelay-1";
    await spawnOn(w, id);
    await waitState(w, id, "idle");

    await w.lifecycle.handlers.attach.handle({ session_id: id }, CMD);
    await waitState(w, id, "human_attached");
    const s1 = await session(w.db, id);
    const tmuxTarget = s1.tmux_target;
    const logPath = s1.pty_log_path;
    expect(tmuxTarget).not.toBeNull();
    expect(logPath).not.toBeNull();

    const client = rawClient(w.relay.path);
    await connected(client.conn);
    client.send({ type: "open", channelId: id, payload: Buffer.alloc(0) });

    // The fixture's interactiveResume stand-in prints this once on start (packages/runners/src/
    // adapters/fixture/adapter.ts) — its arrival over the relay proves the whole chain: real pty
    // output -> registerPtyChannel's read loop -> the relay's ChannelSink -> this raw socket. tmux
    // itself emits terminal control sequences first (clearing the screen, setting the title), so
    // this looks for the text anywhere in the stream, not at a fixed offset.
    const expectedText = `resumed ${s1.runner_session_id}`;
    let seen = Buffer.alloc(0);
    while (!seen.toString("utf8").includes(expectedText)) {
      const frame = await client.next();
      if (frame.type === "data") seen = Buffer.concat([seen, frame.payload]);
    }
    expect(seen.toString("utf8")).toContain(expectedText);

    // Scrollback persistence (§12.5 point 3): the same bytes land in pty_log_path.
    await vi.waitFor(async () => {
      const logged = await readFile(logPath as string, "utf8");
      expect(logged).toContain(`resumed ${s1.runner_session_id}`);
    });

    // A resize and a data frame must not crash the pipe even though the fixture stand-in never
    // reads its stdin meaningfully — this exercises decode + dispatch, not an observable echo.
    client.send({
      type: "data",
      channelId: id,
      payload: Buffer.from(encodePtyResize(120, 40)),
    });
    client.send({
      type: "data",
      channelId: id,
      payload: Buffer.from(encodePtyData(Buffer.from("ls\n", "utf8"))),
    });

    // A heartbeat renews the lease for real: advance the clock past the original expiry, send one,
    // and confirm the DB row's own expiry moved forward from it — the one thing this whole chain
    // exists to make possible for the API side, which can never write sessions itself.
    const before = (await session(w.db, id)).attach_lease_expires_at;
    await w.clock.advance(60_000);
    client.send({
      type: "data",
      channelId: id,
      payload: Buffer.from(encodePtyHeartbeat()),
    });
    await vi.waitFor(async () => {
      const after = (await session(w.db, id)).attach_lease_expires_at;
      expect(after).not.toBeNull();
      expect(after as number).toBeGreaterThan(before as number);
    });

    // Detach tears the channel down; the watching client sees it close.
    client.send({ type: "close", channelId: id, payload: Buffer.alloc(0) });
    client.conn.destroy();
    const detached = await w.lifecycle.handlers.detach.handle(
      { session_id: id },
      CMD,
    );
    expect(detached.ok).toBe(true);
    await vi.waitFor(async () => {
      expect((await session(w.db, id)).state).not.toBe("human_attached");
    });
    // No release: `release` opens a `gate: "release"` run by writing to the runner's stdin, and
    // SCRIPT above declares no gate — its run ends on its own. Calling it here wrote to a process
    // that had already exited whenever the suite was loaded enough for it to finish first, which is
    // what made this test fail about half the time under full-suite load.
  });

  test("a secret printed during a takeover never lands in pty_log_path, whole or split, though the live relay still carries it (FRM-123)", async () => {
    const w = await setup({ prints: "secret" });
    const id = "s-ptyrelay-secret-1";
    await spawnOn(w, id);
    await waitState(w, id, "idle");

    await w.lifecycle.handlers.attach.handle({ session_id: id }, CMD);
    await waitState(w, id, "human_attached");
    const s1 = await session(w.db, id);
    const logPath = s1.pty_log_path;
    expect(logPath).not.toBeNull();

    const client = rawClient(w.relay.path);
    await connected(client.conn);
    client.send({ type: "open", channelId: id, payload: Buffer.alloc(0) });

    // The first part has reached the live relay, so it went out in a pty chunk of its own: the rest
    // is not printed until the keystroke below. Its last MIN_HEAD characters sit mid-row, so they
    // arrive contiguous however tmux draws the wrap. The file is not checked here: the relay gets a
    // chunk before the file does (registerPtyChannel), so a check now could run before the write it
    // means to test. The check after detach covers this moment too — the file only ever grows, far
    // under its cap here, so whatever was written with the value half printed is still in it then.
    let seen = await readUntil(
      client,
      Buffer.alloc(0),
      SECRET_VALUE.slice(SPLIT - MIN_HEAD, SPLIT),
    );

    client.send({
      type: "data",
      channelId: id,
      payload: Buffer.from(encodePtyData(Buffer.from("\r", "utf8"))),
    });
    seen = await readUntil(client, seen, PRINTED);

    // The live relay is the operator's own terminal, and this change never touches it (the plan's
    // scoping decision, pinned here rather than left as a comment): both sides of the split arrive.
    const live = seen.toString("utf8");
    expect(live).toContain(SECRET_VALUE.slice(SPLIT - MIN_HEAD, SPLIT));
    expect(live).toContain(SECRET_VALUE.slice(SPLIT, SPLIT + MIN_HEAD));
    expect(live).not.toContain(REDACTED);

    client.send({ type: "close", channelId: id, payload: Buffer.alloc(0) });
    client.conn.destroy();
    await w.lifecycle.handlers.detach.handle({ session_id: id }, CMD);

    // Detach ends the pty, which flushes whatever the redactor still held. The ring file holds the
    // output after the value, and not the value, whole or in any 8-or-more-character piece.
    await vi.waitFor(async () => {
      const logged = await readFile(logPath as string, "utf8");
      expect(logged).toContain(PRINTED);
      expect(logged).toContain(REDACTED);
      holdsNoPieceOfSecret(logged);
    });
  });

  test("the automated process's live MCP token, printed back by the resumed CLI, never lands in pty_log_path (FRM-123)", async () => {
    const split = 20; // the token is shorter than a row: split it mid-value all the same
    const w = await setup({ prints: "token", split });
    const id = "s-ptyrelay-token-1";
    await spawnOn(w, id);
    await waitState(w, id, "idle");

    await w.lifecycle.handlers.attach.handle({ session_id: id }, CMD);
    await waitState(w, id, "human_attached");
    const logPath = (await session(w.db, id)).pty_log_path;
    expect(logPath).not.toBeNull();
    // The resume is started with a token of its own, which /mcp never learns: the one it still takes
    // is the spawn's, which only the automated process's list holds.
    const token = w.spawnToken();
    expect(token).toBeDefined();
    expect(w.resumeToken()).toBeDefined();
    expect(w.resumeToken()).not.toBe(token);
    if (token === undefined) return;

    const client = rawClient(w.relay.path);
    await connected(client.conn);
    client.send({ type: "open", channelId: id, payload: Buffer.alloc(0) });
    let seen = await readUntil(
      client,
      Buffer.alloc(0),
      token.slice(split - MIN_HEAD, split),
    );
    client.send({
      type: "data",
      channelId: id,
      payload: Buffer.from(encodePtyData(Buffer.from("\r", "utf8"))),
    });
    seen = await readUntil(client, seen, PRINTED);
    expect(seen.toString("utf8")).toContain(
      token.slice(split, split + MIN_HEAD),
    );

    client.send({ type: "close", channelId: id, payload: Buffer.alloc(0) });
    client.conn.destroy();
    await w.lifecycle.handlers.detach.handle({ session_id: id }, CMD);

    await vi.waitFor(async () => {
      const logged = await readFile(logPath as string, "utf8");
      expect(logged).toContain(PRINTED);
      expect(logged).toContain(REDACTED);
      holdsNoPieceOfSecret(logged, token);
    });
  });
});
