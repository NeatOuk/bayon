// The proxy's half of "from the Bayon host itself" (§14 amendment): the header is set
// only for a browser whose TCP peer is loopback, whose page was opened at a loopback origin, and that
// no reverse proxy forwarded; the API's half is apps/api folders/local-request.ts.
import { LOCAL_BROWSER_HEADER as PROTO_HEADER } from "@bayon/proto";
import { describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LOCAL_BROWSER_HEADER,
  isLocalBrowser,
  localKeyReader,
} from "./local-browser.js";

const ORIGINS = new Set([
  "http://localhost:5173",
  "http://127.0.0.1:5173",
  "http://192.0.2.43:5173",
]);
const OWN = {
  origin: "http://localhost:5173",
  "sec-fetch-site": "same-origin",
} as const;

const req = (
  remoteAddress: string | undefined,
  headers: Record<string, string>,
) => ({ socket: { remoteAddress }, headers });

test("the header's name is the one the API reads", () => {
  expect(LOCAL_BROWSER_HEADER).toBe(PROTO_HEADER);
});

describe("isLocalBrowser", () => {
  test.each([
    ["localhost over IPv4", "127.0.0.1", OWN],
    ["localhost over IPv6", "::1", OWN],
    [
      "127.0.0.1",
      "::ffff:127.0.0.1",
      { ...OWN, origin: "http://127.0.0.1:5173" },
    ],
  ])("a page opened at %s on this host is local", (_n, peer, headers) => {
    expect(isLocalBrowser(req(peer, headers), ORIGINS)).toBe(true);
  });

  test.each([
    ["a LAN peer", "192.0.2.7", OWN],
    ["a LAN peer mapped into IPv6", "::ffff:192.0.2.7", OWN],
    ["no peer address", undefined, OWN],
    [
      "the page opened at a LAN address, even on this host",
      "127.0.0.1",
      { ...OWN, origin: "http://192.0.2.43:5173" },
    ],
    [
      "a loopback origin the proxy does not allow",
      "127.0.0.1",
      { ...OWN, origin: "http://localhost:3000" },
    ],
    ["no Origin", "127.0.0.1", { "sec-fetch-site": "same-origin" }],
    [
      "no Sec-Fetch-Site: not a browser",
      "127.0.0.1",
      { origin: "http://localhost:5173" },
    ],
    [
      "a cross-site fetch",
      "127.0.0.1",
      { ...OWN, "sec-fetch-site": "cross-site" },
    ],
    [
      "a reverse proxy on the host (X-Forwarded-For)",
      "127.0.0.1",
      { ...OWN, "x-forwarded-for": "198.51.100.9" },
    ],
    [
      "a reverse proxy on the host (Forwarded)",
      "127.0.0.1",
      { ...OWN, forwarded: "for=198.51.100.9" },
    ],
    [
      "a reverse proxy on the host (X-Real-IP)",
      "127.0.0.1",
      { ...OWN, "x-real-ip": "198.51.100.9" },
    ],
  ])("%s is not local", (_n, peer, headers) => {
    expect(isLocalBrowser(req(peer, headers), ORIGINS)).toBe(false);
  });
});

describe("localKeyReader", () => {
  test("null until the API has written a well-formed key, then that key", () => {
    const dir = mkdtempSync(join(tmpdir(), "frm-webkey-"));
    try {
      const path = join(dir, "local-browser.key");
      const read = localKeyReader(path);
      expect(read()).toBeNull();
      writeFileSync(path, "not a key\n");
      expect(read()).toBeNull();
      const key = "0f".repeat(32);
      writeFileSync(path, `${key}\n`);
      expect(read()).toBe(key);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
