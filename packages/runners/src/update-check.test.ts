import { describe, expect, test, vi } from "vitest";
import { npmLatest } from "./update-check.js";

/** vi.fn's inferred call signature never matches the overloaded global fetch exactly; cast at the door. */
const io = (fetch: (...args: unknown[]) => Promise<Response>) => ({
  fetch: fetch as unknown as typeof globalThis.fetch,
  signal: new AbortController().signal,
});

function jsonResponse(
  body: unknown,
  init: { readonly status?: number; readonly contentLength?: number } = {},
): Response {
  const text = JSON.stringify(body);
  const headers = new Headers();
  headers.set(
    "content-length",
    String(init.contentLength ?? Buffer.byteLength(text)),
  );
  return new Response(text, { status: init.status ?? 200, headers });
}

describe("npmLatest", () => {
  test("GETs the exact URL, no credentials, no redirect followed", async () => {
    const fetch = vi.fn(async () => jsonResponse({ version: "0.3.290" }));
    const got = await npmLatest("@scope/pkg-a", io(fetch));
    expect(got).toEqual({ ok: true, value: "0.3.290" });
    expect(fetch).toHaveBeenCalledWith(
      "https://registry.npmjs.org/%40scope%2Fpkg-a/latest",
      expect.objectContaining({ method: "GET", redirect: "error" }),
    );
    const call: unknown[] = fetch.mock.calls[0] ?? [];
    const options = call[1] as RequestInit | undefined;
    expect(options?.headers).toBeUndefined();
  });

  test("a non-2xx status is a runner_error", async () => {
    const fetch = vi.fn(async () => jsonResponse({}, { status: 500 }));
    const got = await npmLatest("pkg-b", io(fetch));
    expect(got).toMatchObject({ ok: false, error: { class: "runner_error" } });
  });

  test("a body over 64 KiB by Content-Length is refused before it is read", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ version: "1.0.0" }, { contentLength: 70_000 }),
    );
    const got = await npmLatest("pkg-b", io(fetch));
    expect(got).toMatchObject({ ok: false, error: { class: "validation" } });
  });

  test("a body over 64 KiB while streaming is refused even with no Content-Length", async () => {
    const big = "x".repeat(70_000);
    const fetch = vi.fn(async () => {
      const headers = new Headers();
      return new Response(`{"version":"1.0.0","junk":"${big}"}`, {
        status: 200,
        headers,
      });
    });
    const got = await npmLatest("pkg-b", io(fetch));
    expect(got).toMatchObject({ ok: false, error: { class: "validation" } });
  });

  test("a version that fails RELEASE_VERSION is refused, injection included", async () => {
    const fetch = vi.fn(async () =>
      jsonResponse({ version: "latest; rm -rf /" }),
    );
    const got = await npmLatest("pkg-b", io(fetch));
    expect(got).toMatchObject({ ok: false, error: { class: "validation" } });
  });

  test("a network rejection is wrapped, not thrown", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("offline");
    });
    const got = await npmLatest("pkg-b", io(fetch));
    expect(got).toMatchObject({ ok: false, error: { class: "runner_error" } });
  });
});
