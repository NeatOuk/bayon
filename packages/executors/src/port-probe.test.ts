import { createServer, type Server } from "node:net";
import { afterEach, expect, test } from "vitest";
import { portFree } from "./port-probe.js";

// A port held on any of the wildcard or loopback addresses is taken: the GUI's dev server must
// never bind localhost:<port> under another install's *:<port>.

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise((r) => s.close(() => r(null)))),
  );
});

function hold(host: string | undefined): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    servers.push(server);
    server.once("error", reject);
    server.listen({ port: 0, host }, () => {
      const address = server.address();
      if (address === null || typeof address === "string")
        reject(new Error("no port"));
      else resolve(address.port);
    });
  });
}

test("a port held on 0.0.0.0 is taken", async () => {
  expect(await portFree(await hold("0.0.0.0"))).toBe(false);
});

test("a port held on 127.0.0.1 only is taken", async () => {
  expect(await portFree(await hold("127.0.0.1"))).toBe(false);
});

test("a port held on the wildcard is taken", async () => {
  expect(await portFree(await hold(undefined))).toBe(false);
});

test("a port nobody holds is free, and stays free after the probe", async () => {
  const port = await hold("127.0.0.1");
  await new Promise((r) => servers.pop()?.close(() => r(null)));
  expect(await portFree(port)).toBe(true);
  expect(await portFree(port)).toBe(true);
});
