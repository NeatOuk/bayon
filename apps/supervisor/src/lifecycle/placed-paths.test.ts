// Per-executor session paths and what the executor prepared: an executor that
// places sessions names their root, home, tmp and PATH; logs, prompts and the raw log stay local.
// applyPrepared's cases live with it in @bayon/runners.
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unwrap } from "@bayon/db/testing";
import { afterAll, describe, expect, test } from "vitest";
import { makeSessionDirs } from "./home.js";
import { sessionPaths, sessionPathsOn } from "./paths.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "frm-placed-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));

const place = (id: string) => ({
  root: `/frm/s/${id}`,
  home: `/frm/s/${id}/.frm/home`,
  tmp: `/frm/s/${id}/.frm/tmp`,
});

describe("per-executor session paths", () => {
  test("a placing executor names the root, home, tmp and PATH; the rest stays under FRM_HOME", () => {
    const local = sessionPaths("/home/frm", "S1");
    expect(local.remote).toBe(false);
    expect(
      sessionPathsOn("/home/frm", "S1", {
        envPath: "/usr/local/bin:/usr/bin",
        placeSession: place,
      }),
    ).toEqual({
      ...local,
      ...place("S1"),
      remote: true,
      path: "/usr/local/bin:/usr/bin",
    });
    expect(sessionPathsOn("/home/frm", "S1", undefined)).toEqual(local);
    expect(sessionPathsOn("/home/frm", "S1", {})).toEqual(local);
  });

  test("makeSessionDirs makes only a placed session's local dirs", async () => {
    const paths = {
      ...sessionPaths(base, "S1"),
      home: join(base, "not-here", "home"),
      tmp: join(base, "not-here", "tmp"),
      remote: true,
    };
    unwrap(await makeSessionDirs(paths));
    expect(existsSync(paths.logs)).toBe(true);
    expect(existsSync(paths.prompts)).toBe(true);
    expect(existsSync(join(base, "not-here"))).toBe(false);
  });
});
