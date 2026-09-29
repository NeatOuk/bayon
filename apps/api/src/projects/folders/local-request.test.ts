// "From the Bayon host itself" (§14 amendment): the proxy's header counts only when it
// carries the host-only key, on a loopback socket, with no sign a reverse proxy forwarded it.
import { LOCAL_BROWSER_HEADER } from "@bayon/proto";
import { describe, expect, test } from "vitest";
import { isLocalRequest, isLoopback } from "./local-request.js";

const KEY = "ab".repeat(32);

const request = (
  remoteAddress: string | undefined,
  headers: Record<string, string | string[]> = {},
) => ({ socket: { remoteAddress }, headers });

const withKey = { [LOCAL_BROWSER_HEADER]: KEY };

describe("isLoopback", () => {
  test.each(["127.0.0.1", "127.8.9.10", "::1", "::ffff:127.0.0.1"])(
    "%s is loopback",
    (address) => expect(isLoopback(address)).toBe(true),
  );
  test.each([
    "192.0.2.1",
    "::ffff:192.0.2.1",
    "10.0.0.1",
    "fe80::1",
    "0.0.0.0",
    "127.0.0.1.example",
    "",
    undefined,
  ])("%s is not", (address) => expect(isLoopback(address)).toBe(false));
});

describe("isLocalRequest", () => {
  test("the key on a loopback socket is local", () => {
    expect(isLocalRequest(request("127.0.0.1", withKey), KEY)).toBe(true);
    expect(isLocalRequest(request("::1", withKey), KEY)).toBe(true);
  });

  test("without the header, or with any other value, it is not", () => {
    expect(isLocalRequest(request("127.0.0.1"), KEY)).toBe(false);
    for (const value of ["1", "", KEY.slice(1), `${KEY}0`, KEY.toUpperCase()]) {
      expect(
        isLocalRequest(
          request("127.0.0.1", { [LOCAL_BROWSER_HEADER]: value }),
          KEY,
        ),
      ).toBe(false);
    }
  });

  test("a repeated header is not local", () => {
    expect(
      isLocalRequest(
        request("127.0.0.1", { [LOCAL_BROWSER_HEADER]: [KEY, KEY] }),
        KEY,
      ),
    ).toBe(false);
  });

  test("with no key (no FRM_HOME, or it could not be written) nothing is local", () => {
    expect(isLocalRequest(request("127.0.0.1", withKey), null)).toBe(false);
  });

  test("the right key from a LAN socket is ignored: a direct call cannot claim to be local", () => {
    expect(isLocalRequest(request("192.0.2.43", withKey), KEY)).toBe(false);
    expect(isLocalRequest(request("::ffff:192.0.2.43", withKey), KEY)).toBe(
      false,
    );
  });

  test.each([
    ["Forwarded", "forwarded", "for=198.51.100.9"],
    ["X-Forwarded-For", "x-forwarded-for", "198.51.100.9"],
    ["X-Real-IP", "x-real-ip", "198.51.100.9"],
  ])("a request a reverse proxy forwarded (%s) is not local", (_n, name, v) => {
    expect(
      isLocalRequest(request("127.0.0.1", { ...withKey, [name]: v }), KEY),
    ).toBe(false);
  });
});
