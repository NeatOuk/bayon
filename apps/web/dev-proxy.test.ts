import { EventEmitter } from "node:events";
import type { ProxyOptions } from "vite";
import { describe, expect, test, vi } from "vitest";
import { apiProxy, extraOrigins, mayUseBearer } from "./dev-proxy.js";
import { LOCAL_BROWSER_HEADER } from "./server/local-browser.js";

const ORIGINS = new Set(["http://localhost:5173"]);
const TARGET = "http://127.0.0.1:3010";
const TOKEN = "t".repeat(32);
const KEY = "5a".repeat(32);

describe("mayUseBearer", () => {
  test.each([
    ["a non-browser client", {}],
    [
      "a same-origin fetch",
      { origin: "http://localhost:5173", "sec-fetch-site": "same-origin" },
    ],
    ["a typed-in URL", { "sec-fetch-site": "none" }],
  ])("allows %s", (_name, headers) => {
    expect(mayUseBearer(headers, ORIGINS)).toBe(true);
  });

  test.each([
    [
      "another site",
      { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    ],
    [
      "another localhost port",
      { origin: "http://localhost:3000", "sec-fetch-site": "same-site" },
    ],
    ["a foreign Origin without fetch metadata", { origin: "https://x.test" }],
    ["a cross-site request without Origin", { "sec-fetch-site": "cross-site" }],
  ])("refuses %s", (_name, headers) => {
    expect(mayUseBearer(headers, ORIGINS)).toBe(false);
  });
});

describe("extraOrigins (FRM_WEB_ORIGINS)", () => {
  test("unset or empty adds nothing: the defaults stay localhost only", () => {
    expect(extraOrigins(undefined)).toEqual([]);
    expect(extraOrigins("")).toEqual([]);
    expect(extraOrigins(" , ")).toEqual([]);
  });

  test("a list of bare origins, trimmed and normalised", () => {
    expect(
      extraOrigins(" http://192.0.2.43:5173 ,https://Mac.local:4173"),
    ).toEqual(["http://192.0.2.43:5173", "https://mac.local:4173"]);
  });

  test.each([
    ["a path", "http://192.0.2.43:5173/app"],
    ["a trailing slash", "http://192.0.2.43:5173/"],
    ["a query", "http://192.0.2.43:5173?x=1"],
    ["credentials", "http://u:p@192.0.2.43:5173"],
    ["another scheme", "ftp://192.0.2.43:5173"],
    ["not a URL", "192.0.2.43:5173x"],
  ])("refuses %s, loudly", (_name, entry) => {
    expect(() => extraOrigins(entry)).toThrow(/FRM_WEB_ORIGINS/);
  });

  test("a listed LAN origin gets the bearer; an unlisted one still does not", () => {
    const lan = new Set([
      ...ORIGINS,
      ...extraOrigins("http://192.0.2.43:5173"),
    ]);
    expect(
      mayUseBearer(
        { origin: "http://192.0.2.43:5173", "sec-fetch-site": "same-origin" },
        lan,
      ),
    ).toBe(true);
    expect(
      mayUseBearer(
        { origin: "http://192.168.0.99:5173", "sec-fetch-site": "same-origin" },
        lan,
      ),
    ).toBe(false);
  });
});

type ProxyServer = Parameters<NonNullable<ProxyOptions["configure"]>>[0];

/** Runs one proxied request through `options.configure`; returns what it did to the upstream request. */
function forward(
  options: ProxyOptions,
  event: "proxyReq" | "proxyReqWs",
  headers: Record<string, string>,
  remoteAddress = "192.0.2.7",
) {
  return forwardWith(options, event, headers, remoteAddress).setHeader;
}

function forwardWith(
  options: ProxyOptions,
  event: "proxyReq" | "proxyReqWs",
  headers: Record<string, string>,
  remoteAddress: string,
) {
  const proxy = new EventEmitter();
  options.configure?.(proxy as unknown as ProxyServer, options);
  const setHeader = vi.fn();
  const removeHeader = vi.fn();
  proxy.emit(
    event,
    { setHeader, removeHeader },
    { headers, socket: { remoteAddress } },
  );
  return { setHeader, removeHeader };
}

describe("apiProxy", () => {
  const proxies = apiProxy({
    target: TARGET,
    token: TOKEN,
    allowedOrigins: ORIGINS,
    localKey: () => KEY,
  });

  test("forwards /api over HTTP and /ws, /ws/pty as WebSocket upgrades", () => {
    expect(proxies["/api"]).toMatchObject({ target: TARGET });
    expect(proxies["/ws"]).toMatchObject({ target: TARGET, ws: true });
    expect(proxies["/ws/pty"]).toMatchObject({ target: TARGET, ws: true });
  });

  test("injects the bearer into same-origin HTTP and WebSocket requests", () => {
    const origin = { origin: "http://localhost:5173" };
    expect(forward(proxies["/api"], "proxyReq", origin)).toHaveBeenCalledWith(
      "authorization",
      `Bearer ${TOKEN}`,
    );
    expect(forward(proxies["/ws"], "proxyReqWs", origin)).toHaveBeenCalledWith(
      "authorization",
      `Bearer ${TOKEN}`,
    );
  });

  test("a cross-site request goes through without the bearer", () => {
    const setHeader = forward(proxies["/ws"], "proxyReqWs", {
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    });
    expect(setHeader).not.toHaveBeenCalled();
  });

  test("without FRM_API_TOKEN nothing is injected", () => {
    const bare = apiProxy({
      target: TARGET,
      token: undefined,
      allowedOrigins: ORIGINS,
      localKey: () => KEY,
    });
    expect(forward(bare["/api"], "proxyReq", {})).not.toHaveBeenCalled();
  });

  // §14 amendment: the proxy alone says whether the browser is on this host.
  const OWN = {
    origin: "http://localhost:5173",
    "sec-fetch-site": "same-origin",
  };

  test("a browser on this host gets the local header beside the bearer", () => {
    const { setHeader } = forwardWith(
      proxies["/api"],
      "proxyReq",
      OWN,
      "127.0.0.1",
    );
    expect(setHeader).toHaveBeenCalledWith(LOCAL_BROWSER_HEADER, KEY);
  });

  test("with no key readable, no browser is local", () => {
    const keyless = apiProxy({
      target: TARGET,
      token: TOKEN,
      allowedOrigins: ORIGINS,
      localKey: () => null,
    });
    const { setHeader } = forwardWith(
      keyless["/api"],
      "proxyReq",
      OWN,
      "127.0.0.1",
    );
    expect(setHeader).toHaveBeenCalledWith("authorization", `Bearer ${TOKEN}`);
    expect(setHeader).not.toHaveBeenCalledWith(
      LOCAL_BROWSER_HEADER,
      expect.anything(),
    );
  });

  test("another localhost port (same-site) gets neither the bearer nor the local header", () => {
    const { setHeader, removeHeader } = forwardWith(
      proxies["/api"],
      "proxyReq",
      { origin: "http://localhost:3000", "sec-fetch-site": "same-site" },
      "127.0.0.1",
    );
    expect(removeHeader).toHaveBeenCalledWith(LOCAL_BROWSER_HEADER);
    expect(setHeader).not.toHaveBeenCalled();
  });

  test("a LAN browser does not, and a copy it sent is removed", () => {
    const { setHeader, removeHeader } = forwardWith(
      proxies["/api"],
      "proxyReq",
      { ...OWN, [LOCAL_BROWSER_HEADER]: "1" },
      "192.0.2.7",
    );
    expect(removeHeader).toHaveBeenCalledWith(LOCAL_BROWSER_HEADER);
    expect(setHeader).not.toHaveBeenCalledWith(
      LOCAL_BROWSER_HEADER,
      expect.anything(),
    );
  });

  test("a copy is removed even from a request that gets no bearer", () => {
    const { setHeader, removeHeader } = forwardWith(
      proxies["/ws"],
      "proxyReqWs",
      {
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
        [LOCAL_BROWSER_HEADER]: "1",
      },
      "127.0.0.1",
    );
    expect(removeHeader).toHaveBeenCalledWith(LOCAL_BROWSER_HEADER);
    expect(setHeader).not.toHaveBeenCalled();
  });
});
