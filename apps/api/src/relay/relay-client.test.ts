import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import {
  RelayFrameDecoder,
  encodeRelayFrame,
  type RelayFrame,
} from "@bayon/core";
import { afterAll, expect, test } from "vitest";
import { connectRelay } from "./relay-client.js";

const dir = mkdtempSync("/tmp/frm-relay-client-");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * A tiny raw server double for testing the client in isolation from apps/supervisor's real relay
 * server (a cross-package import would be wrong — apps/api and apps/supervisor are separate
 * processes/packages). `onOpen` decides how to answer an `open` for a channel id; `onData` is
 * called for `data` frames on channels that were accepted.
 */
function rawServer(
  path: string,
  handlers: {
    onOpen: (channelId: string) => "accept" | "refuse";
    onData?: (channelId: string, conn: Socket, bytes: Buffer) => void;
  },
): Promise<{ server: Server; connections: Set<Socket> }> {
  const connections = new Set<Socket>();
  return new Promise((resolve) => {
    const server = createServer((conn) => {
      connections.add(conn);
      conn.on("close", () => connections.delete(conn));
      const decoder = new RelayFrameDecoder();
      conn.on("data", (chunk: Buffer) => {
        for (const step of decoder.push(chunk)) {
          if (!step.ok) continue;
          const frame = step.frame;
          if (frame.type === "open") {
            const verdict = handlers.onOpen(frame.channelId);
            if (verdict === "refuse") {
              conn.write(
                encodeRelayFrame({
                  type: "error",
                  channelId: frame.channelId,
                  payload: Buffer.from("no such channel", "utf8"),
                } satisfies RelayFrame),
              );
            }
          } else if (frame.type === "data") {
            handlers.onData?.(frame.channelId, conn, frame.payload);
          }
        }
      });
    });
    server.listen(path, () => resolve({ server, connections }));
  });
}

const closeServer = ({
  server,
  connections,
}: {
  server: Server;
  connections: Set<Socket>;
}): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => resolve());
    for (const conn of connections) conn.destroy();
  });

test("openChannel sends bytes and receives the server's replies", async () => {
  const path = join(dir, "a.sock");
  const server = await rawServer(path, {
    onOpen: () => "accept",
    onData: (channelId, conn, bytes) =>
      conn.write(
        encodeRelayFrame({
          type: "data",
          channelId,
          payload: Buffer.concat([Buffer.from("echo:"), bytes]),
        }),
      ),
  });
  const client = connectRelay(path);
  const channel = client.openChannel("s1");
  const received: Buffer[] = [];
  channel.onData((b) => received.push(b));
  channel.send(Buffer.from("hi"));
  await wait(30);
  expect(received).toEqual([Buffer.from("echo:hi")]);
  client.close();
  await closeServer(server);
});

test("a refused open fires onClose with the server's reason", async () => {
  const path = join(dir, "b.sock");
  const server = await rawServer(path, { onOpen: () => "refuse" });
  const client = connectRelay(path);
  const channel = client.openChannel("ghost");
  const reasons: string[] = [];
  channel.onClose((r) => reasons.push(r));
  await wait(30);
  expect(reasons).toEqual(["no such channel"]);
  client.close();
  await closeServer(server);
});

test("channel.close() stops the client from delivering further data for it", async () => {
  const path = join(dir, "c.sock");
  const server = await rawServer(path, {
    onOpen: () => "accept",
    onData: (channelId, conn, bytes) =>
      conn.write(encodeRelayFrame({ type: "data", channelId, payload: bytes })),
  });
  const client = connectRelay(path);
  const channel = client.openChannel("s1");
  const received: Buffer[] = [];
  channel.onData((b) => received.push(b));
  channel.send(Buffer.from("one"));
  await wait(30);
  channel.close();
  channel.send(Buffer.from("two")); // no-op after close: the server never sees it
  await wait(30);
  expect(received).toEqual([Buffer.from("one")]);
  client.close();
  await closeServer(server);
});

test("the relay socket closing fires onClose for every open channel, cleanly", async () => {
  const path = join(dir, "d.sock");
  const server = await rawServer(path, { onOpen: () => "accept" });
  const client = connectRelay(path);
  const channel = client.openChannel("s1");
  const reasons: string[] = [];
  channel.onClose((r) => reasons.push(r));
  await wait(30);
  await closeServer(server);
  await wait(30);
  expect(reasons).toHaveLength(1);
  client.close(); // must not throw on an already-torn-down connection
});

test("openChannel after the connection is already closed fires onClose instead of hanging forever", async () => {
  const path = join(dir, "f.sock");
  const server = await rawServer(path, { onOpen: () => "accept" });
  const client = connectRelay(path);
  client.close(); // synchronous: `closed` is already true by the time this returns
  const channel = client.openChannel("too-late");
  const reasons: string[] = [];
  channel.onClose((r) => reasons.push(r));
  await wait(0); // the report is queued via a microtask, not fired synchronously
  expect(reasons).toEqual(["relay connection already closed"]);
  channel.send(Buffer.from("dropped")); // no-op, no throw
  channel.close(); // no-op, no throw
  await closeServer(server);
});

test("two channels multiplex over one client connection without cross-talk", async () => {
  const path = join(dir, "e.sock");
  const server = await rawServer(path, {
    onOpen: () => "accept",
    onData: (channelId, conn, bytes) =>
      conn.write(encodeRelayFrame({ type: "data", channelId, payload: bytes })),
  });
  const client = connectRelay(path);
  const a = client.openChannel("a");
  const b = client.openChannel("b");
  const gotA: Buffer[] = [];
  const gotB: Buffer[] = [];
  a.onData((x) => gotA.push(x));
  b.onData((x) => gotB.push(x));
  a.send(Buffer.from("A"));
  b.send(Buffer.from("B"));
  await wait(30);
  expect(gotA).toEqual([Buffer.from("A")]);
  expect(gotB).toEqual([Buffer.from("B")]);
  client.close();
  await closeServer(server);
});
