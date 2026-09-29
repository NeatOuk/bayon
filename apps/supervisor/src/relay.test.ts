import { existsSync, lstatSync, mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import {
  RelayFrameDecoder,
  encodeRelayFrame,
  type RelayFrame,
} from "@bayon/core";
import { unwrap } from "@bayon/db/testing";
import { pino } from "pino";
import { afterAll, expect, test } from "vitest";
import { openRelayServer } from "./relay.js";

const dir = mkdtempSync("/tmp/frm-relay-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const log = pino({ level: "silent" });

/** A tiny raw client for driving the wire protocol directly, without apps/api's own client module. */
function rawClient(path: string): {
  conn: Socket;
  frames: RelayFrame[];
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
    frames,
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

test("opening a registered channel binds it; data flows both ways", async () => {
  const path = join(dir, "a.sock");
  const server = unwrap(await openRelayServer({ path, log }));
  const received: Buffer[] = [];
  const sink = unwrap(
    server.register("s1", {
      onData: (b) => received.push(b),
      onClose: () => undefined,
    }),
  );
  const client = rawClient(path);
  await connected(client.conn);
  client.send({ type: "open", channelId: "s1", payload: Buffer.alloc(0) });
  client.send({
    type: "data",
    channelId: "s1",
    payload: Buffer.from("hello"),
  });
  await new Promise((r) => setTimeout(r, 20));
  expect(received).toEqual([Buffer.from("hello")]);

  sink.write(Buffer.from("world"));
  const frame = await client.next();
  expect(frame).toEqual({
    type: "data",
    channelId: "s1",
    payload: Buffer.from("world"),
  });
  await server.close();
});

test("opening an unregistered channel gets an error frame, no bind", async () => {
  const path = join(dir, "b.sock");
  const server = unwrap(await openRelayServer({ path, log }));
  const client = rawClient(path);
  await connected(client.conn);
  client.send({ type: "open", channelId: "ghost", payload: Buffer.alloc(0) });
  const frame = await client.next();
  expect(frame.type).toBe("error");
  expect(frame.channelId).toBe("ghost");
  await server.close();
});

test("a second open while already bound to another connection is refused", async () => {
  const path = join(dir, "c.sock");
  const server = unwrap(await openRelayServer({ path, log }));
  server.register("s1", { onData: () => undefined, onClose: () => undefined });
  const first = rawClient(path);
  await connected(first.conn);
  first.send({ type: "open", channelId: "s1", payload: Buffer.alloc(0) });
  await new Promise((r) => setTimeout(r, 20));

  const second = rawClient(path);
  await connected(second.conn);
  second.send({ type: "open", channelId: "s1", payload: Buffer.alloc(0) });
  const frame = await second.next();
  expect(frame.type).toBe("error");
  await server.close();
});

test("two channels multiplex over one connection without cross-talk", async () => {
  const path = join(dir, "d.sock");
  const server = unwrap(await openRelayServer({ path, log }));
  const receivedA: Buffer[] = [];
  const receivedB: Buffer[] = [];
  server.register("a", {
    onData: (b) => receivedA.push(b),
    onClose: () => undefined,
  });
  server.register("b", {
    onData: (b) => receivedB.push(b),
    onClose: () => undefined,
  });
  const client = rawClient(path);
  await connected(client.conn);
  client.send({ type: "open", channelId: "a", payload: Buffer.alloc(0) });
  client.send({ type: "open", channelId: "b", payload: Buffer.alloc(0) });
  client.send({ type: "data", channelId: "a", payload: Buffer.from("A") });
  client.send({ type: "data", channelId: "b", payload: Buffer.from("B") });
  await new Promise((r) => setTimeout(r, 20));
  expect(receivedA).toEqual([Buffer.from("A")]);
  expect(receivedB).toEqual([Buffer.from("B")]);
  await server.close();
});

test("a client's close unbinds without unregistering: a fresh open reopens it", async () => {
  const path = join(dir, "e.sock");
  const server = unwrap(await openRelayServer({ path, log }));
  let closes = 0;
  const sink = unwrap(
    server.register("s1", {
      onData: () => undefined,
      onClose: () => (closes += 1),
    }),
  );
  const first = rawClient(path);
  await connected(first.conn);
  first.send({ type: "open", channelId: "s1", payload: Buffer.alloc(0) });
  await new Promise((r) => setTimeout(r, 20));
  first.send({ type: "close", channelId: "s1", payload: Buffer.alloc(0) });
  await new Promise((r) => setTimeout(r, 20));
  expect(closes).toBe(1);
  sink.write(Buffer.from("dropped, nobody listening")); // no-op, no throw

  const second = rawClient(path);
  await connected(second.conn);
  second.send({ type: "open", channelId: "s1", payload: Buffer.alloc(0) });
  await new Promise((r) => setTimeout(r, 20));
  sink.write(Buffer.from("hi again"));
  const frame = await second.next();
  expect(frame).toEqual({
    type: "data",
    channelId: "s1",
    payload: Buffer.from("hi again"),
  });
  await server.close();
});

test("a connection dropping unbinds its channels and fires onClose", async () => {
  const path = join(dir, "f.sock");
  const server = unwrap(await openRelayServer({ path, log }));
  let closes = 0;
  server.register("s1", {
    onData: () => undefined,
    onClose: () => (closes += 1),
  });
  const client = rawClient(path);
  await connected(client.conn);
  client.send({ type: "open", channelId: "s1", payload: Buffer.alloc(0) });
  await new Promise((r) => setTimeout(r, 20));
  client.conn.destroy();
  await new Promise((r) => setTimeout(r, 20));
  expect(closes).toBe(1);
  await server.close();
});

test("a connection dropping unbinds EVERY channel it had open, not just the last one", async () => {
  const path = join(dir, "f2.sock");
  const server = unwrap(await openRelayServer({ path, log }));
  let closesA = 0;
  let closesB = 0;
  const sinkA = unwrap(
    server.register("a", {
      onData: () => undefined,
      onClose: () => (closesA += 1),
    }),
  );
  const sinkB = unwrap(
    server.register("b", {
      onData: () => undefined,
      onClose: () => (closesB += 1),
    }),
  );
  const client = rawClient(path);
  await connected(client.conn);
  client.send({ type: "open", channelId: "a", payload: Buffer.alloc(0) });
  client.send({ type: "open", channelId: "b", payload: Buffer.alloc(0) });
  await new Promise((r) => setTimeout(r, 20));
  client.conn.destroy();
  await new Promise((r) => setTimeout(r, 20));
  expect(closesA).toBe(1);
  expect(closesB).toBe(1);

  // Both channels must be reopenable afterwards, not stuck "already open" against a dead socket —
  // proven by relaying real data through each, the same way the single-channel reopen test does.
  const second = rawClient(path);
  await connected(second.conn);
  second.send({ type: "open", channelId: "a", payload: Buffer.alloc(0) });
  second.send({ type: "open", channelId: "b", payload: Buffer.alloc(0) });
  await new Promise((r) => setTimeout(r, 20));
  sinkA.write(Buffer.from("a-again"));
  sinkB.write(Buffer.from("b-again"));
  const first = await second.next();
  const rest = await second.next();
  const byChannel = new Map([first, rest].map((f) => [f.channelId, f]));
  expect(byChannel.get("a")).toEqual({
    type: "data",
    channelId: "a",
    payload: Buffer.from("a-again"),
  });
  expect(byChannel.get("b")).toEqual({
    type: "data",
    channelId: "b",
    payload: Buffer.from("b-again"),
  });
  await server.close();
});

test("sink.close() tells the open connection and removes the channel for good", async () => {
  const path = join(dir, "g.sock");
  const server = unwrap(await openRelayServer({ path, log }));
  const sink = unwrap(
    server.register("s1", {
      onData: () => undefined,
      onClose: () => undefined,
    }),
  );
  const client = rawClient(path);
  await connected(client.conn);
  client.send({ type: "open", channelId: "s1", payload: Buffer.alloc(0) });
  await new Promise((r) => setTimeout(r, 20));
  sink.close();
  const frame = await client.next();
  expect(frame).toEqual({
    type: "close",
    channelId: "s1",
    payload: Buffer.alloc(0),
  });

  client.send({ type: "open", channelId: "s1", payload: Buffer.alloc(0) });
  const reopen = await client.next();
  expect(reopen.type).toBe("error"); // the channel no longer exists
  await server.close();
});

test("registering the same channel id twice is a conflict", async () => {
  const path = join(dir, "h.sock");
  const server = unwrap(await openRelayServer({ path, log }));
  server.register("s1", { onData: () => undefined, onClose: () => undefined });
  const second = server.register("s1", {
    onData: () => undefined,
    onClose: () => undefined,
  });
  expect(second.ok ? null : second.error.class).toBe("conflict");
  await server.close();
});

test("close() ends every bound connection's channel and removes the socket file", async () => {
  const path = join(dir, "i.sock");
  const server = unwrap(await openRelayServer({ path, log }));
  server.register("s1", { onData: () => undefined, onClose: () => undefined });
  const client = rawClient(path);
  await connected(client.conn);
  client.send({ type: "open", channelId: "s1", payload: Buffer.alloc(0) });
  await new Promise((r) => setTimeout(r, 20));
  await server.close();
  expect(existsSync(path)).toBe(false);
});

test("a stale socket left by a killed process is replaced", async () => {
  const path = join(dir, "j.sock");
  const script =
    "require('net').createServer().listen(process.argv[1], () => process.kill(process.pid, 'SIGKILL'))";
  const child = spawnSync(process.execPath, ["-e", script, path]);
  expect(child.signal).toBe("SIGKILL");
  expect(lstatSync(path).isSocket()).toBe(true);
  const server = unwrap(await openRelayServer({ path, log }));
  const client = rawClient(path);
  await connected(client.conn);
  server.register("s1", { onData: () => undefined, onClose: () => undefined });
  client.send({ type: "open", channelId: "s1", payload: Buffer.alloc(0) });
  await new Promise((r) => setTimeout(r, 20));
  expect(client.frames).toEqual([]); // accepted (registered before the open), no error frame
  await server.close();
});

test("a path over the socket-address limit fails loudly, creating nothing", async () => {
  const path = join(dir, `${"x".repeat(200)}.sock`);
  const opened = await openRelayServer({ path, log });
  expect(opened.ok).toBe(false);
  if (opened.ok) return;
  expect(opened.error.class).toBe("validation");
  expect(existsSync(path)).toBe(false);
});
