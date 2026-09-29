import { describe, expect, test, vi } from "vitest";
import { PINNED_VERSION } from "./registration.js";
import { updateCheck } from "./update-check.js";

const io = (fetch: typeof globalThis.fetch) => ({
  fetch,
  signal: new AbortController().signal,
});

describe("opencode updateCheck", () => {
  test("checks opencode-ai and reports the pinned version, no notes_url", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ version: "1.18.33" }, { status: 200 }),
    );
    const got = await updateCheck(io(fetch));
    expect(got).toEqual({
      ok: true,
      value: { current: PINNED_VERSION, latest: "1.18.33" },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://registry.npmjs.org/opencode-ai/latest",
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("a failed fetch is the plain error, not thrown", async () => {
    const fetch = vi.fn(async () => Response.json({}, { status: 500 }));
    const got = await updateCheck(io(fetch));
    expect(got).toMatchObject({ ok: false });
  });
});
