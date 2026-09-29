// The real cross-process test the plan calls for: a genuine second OS process (not an in-process
// fake) running the relay server, a real client connecting to it, real bytes relayed, then a hard
// kill mid-relay to prove the connection detects the disconnect cleanly (no wedge), and a fresh
// process on the same socket path works again afterward. Mirrors how
// apps/supervisor/src/lifecycle/plug.test.ts spawns the real supervisor from dist/main.js — this
// spawns the lighter relay-fixture.js instead, since the wire protocol is what's under test, not
// the whole supervisor boot sequence.
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createConnection, type Socket } from "node:net";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { RelayFrameDecoder, encodeRelayFrame } from "@bayon/core";
import { afterAll, expect, test, vi } from "vitest";

const FIXTURE = fileURLToPath(
  new URL("../dist/relay-fixture.js", import.meta.url),
);
const dir = mkdtempSync("/tmp/frm-relay-e2e-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

type Child = ChildProcessByStdio<null, Readable, Readable>;

/** Spawns the fixture and resolves once it prints "ready". */
function spawnFixture(path: string, channelId: string): Promise<Child> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FIXTURE, path, channelId], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (chunk.toString("utf8").includes("ready")) resolve(child);
    });
    child.stderr.on("data", (chunk: Buffer) =>
      reject(new Error(chunk.toString("utf8"))),
    );
    child.once("error", reject);
  });
}

type Frame = { type: string; channelId: string; payload: Buffer };

function rawClient(path: string): {
  conn: Socket;
  next(): Promise<Frame>;
  send(
    type: "open" | "data" | "close",
    channelId: string,
    payload?: Buffer,
  ): void;
} {
  const conn = createConnection(path);
  const decoder = new RelayFrameDecoder();
  const queued: Frame[] = [];
  const waiters: ((f: Frame) => void)[] = [];
  conn.on("data", (chunk: Buffer) => {
    for (const step of decoder.push(chunk)) {
      if (!step.ok) continue;
      const waiter = waiters.shift();
      if (waiter) waiter(step.frame);
      else queued.push(step.frame);
    }
  });
  return {
    conn,
    next: () =>
      new Promise((resolve) => {
        const already = queued.shift();
        if (already !== undefined) {
          resolve(already);
          return;
        }
        waiters.push(resolve);
      }),
    send: (type, channelId, payload = Buffer.alloc(0)) =>
      conn.write(encodeRelayFrame({ type, channelId, payload })),
  };
}

const connected = (conn: Socket): Promise<void> =>
  new Promise((resolve) => conn.once("connect", () => resolve()));

const dead = (child: Child): Promise<void> =>
  new Promise((resolve) => child.once("exit", () => resolve()));

/** Echoes bytes back once (the fixture's own protocol), and reports the client-side closure. */
async function echoRoundTrip(path: string, channelId: string, text: string) {
  const client = rawClient(path);
  await connected(client.conn);
  client.send("open", channelId);
  client.send("data", channelId, Buffer.from(text));
  const reply = await client.next();
  expect(reply).toEqual({
    type: "data",
    channelId,
    payload: Buffer.from(`echo:${text}`),
  });
  return client;
}

test("a real second process relays bytes; a hard kill mid-relay is detected cleanly, and a fresh process works again", async () => {
  const path = join(dir, "relay.sock");
  const child1 = await spawnFixture(path, "s1");
  const client1 = await echoRoundTrip(path, "s1", "hello");

  // A hard kill, mid-relay: the fixture process disappears without a clean shutdown. The
  // connection can close before this test process even reaps the child, so watch for it from
  // the start rather than registering a listener afterward (a fired event never replays).
  let client1Closed = false;
  client1.conn.once("close", () => (client1Closed = true));
  child1.kill("SIGKILL");
  await dead(child1);
  await vi.waitFor(() => expect(client1Closed).toBe(true));

  // A fresh process on the same socket path (the stale-socket-file path openRelayServer already
  // exercises in relay.test.ts) comes up and serves fresh connections normally — no wedge left
  // behind by the crash.
  const child2 = await spawnFixture(path, "s1");
  await echoRoundTrip(path, "s1", "again");
  child2.kill("SIGKILL");
  await dead(child2);
}, 20_000);
