import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import { SDK_PACKAGE } from "./registration.js";
import { SDK_CHANGELOG_URL, updateCheck } from "./update-check.js";

const io = (fetch: typeof globalThis.fetch) => ({
  fetch,
  signal: new AbortController().signal,
});

function installedVersion(): string {
  const dir = dirname(createRequire(import.meta.url).resolve(SDK_PACKAGE));
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

describe("claude-sdk updateCheck", () => {
  test("checks the SDK's own package name and reports the installed version and the changelog", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ version: "99.0.0" }, { status: 200 }),
    );
    const got = await updateCheck(io(fetch));
    expect(got).toEqual({
      ok: true,
      value: {
        current: installedVersion(),
        latest: "99.0.0",
        notes_url: SDK_CHANGELOG_URL,
      },
    });
    expect(fetch).toHaveBeenCalledWith(
      `https://registry.npmjs.org/${encodeURIComponent(SDK_PACKAGE)}/latest`,
      expect.objectContaining({ method: "GET" }),
    );
  });

  test("a failed fetch is the plain error, not thrown", async () => {
    const fetch = vi.fn(async () => Response.json({}, { status: 500 }));
    const got = await updateCheck(io(fetch));
    expect(got).toMatchObject({ ok: false });
  });
});
