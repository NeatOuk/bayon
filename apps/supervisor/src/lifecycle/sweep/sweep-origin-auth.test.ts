// The sweep's base fetch from a private https origin: offered the forge token, by env
// only, when FORGE_TOKEN_GITHUB is in the store — against the stand-in forge that demands one.
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { forgeTokenSecret } from "@bayon/core";
import { seedRows, tempDb, unwrap, type SeedRows } from "@bayon/db/testing";
import { afterAll, expect, test } from "vitest";
import { envSecrets } from "../secrets.js";
import { FORGE_URL, standInForge } from "../testing/forge-remote.js";
import { sweepPass } from "./sweep.js";
import {
  cleanupWorlds,
  git,
  sweepWorld,
  type OpenDb,
} from "./testing/sweep-world.js";

afterAll(cleanupWorlds);

const TOKEN = "ghp_sweep_standin_31c9";
const open: OpenDb = async (clock) => {
  const t = unwrap(await tempDb(clock));
  return {
    db: t.db,
    drop: t.cleanup,
    seed: async (rows) => {
      unwrap(await seedRows(t.db, rows as SeedRows));
    },
  };
};

test("the sweep's base fetch of an https github origin is offered the token", async () => {
  const w = await sweepWorld(open);
  const src = join(w.root, "forge-src");
  mkdirSync(src, { recursive: true });
  git(src, "init", "-q", "-b", "main");
  writeFileSync(join(src, "README.md"), "hello\n");
  git(src, "add", "-A");
  git(src, "commit", "-q", "-m", "base");
  const base = git(src, "rev-parse", "HEAD");
  const mirror = join(w.root, "home", "mirrors", "priv.git");
  git(w.root, "clone", "-q", "--mirror", src, mirror);
  await w.seed({
    repos: [
      { id: "priv", name: "priv", mirror_path: mirror, origin_url: FORGE_URL },
    ],
    workspaces: [{ id: "ws-priv", name: "ws-priv", kind: "single" }],
    workspace_repos: [
      {
        workspace_id: "ws-priv",
        repo_id: "priv",
        rel_path: "priv",
        role: "primary",
      },
    ],
  });
  const repo = {
    id: "priv",
    origin: FORGE_URL,
    mirror,
    base,
    workspace: "ws-priv",
  };
  await w.worktree({ sid: "S1", repo });
  git(src, "commit", "-q", "--allow-empty", "-m", "two");
  const forge = standInForge({ dir: w.root, source: src, token: TOKEN });
  await sweepPass(
    {
      ...w.deps,
      path: forge.path,
      secrets: envSecrets({
        [`FRM_SECRET_${forgeTokenSecret("github")}`]: TOKEN,
      }),
    },
    new AbortController().signal,
  );
  const fetches = forge.calls().filter((c) => c.args.includes("fetch"));
  expect(fetches.length).toBeGreaterThan(0);
  expect(fetches.every((c) => c.tokenInEnv)).toBe(true);
  expect(git(mirror, "rev-parse", "refs/remotes/origin/main")).toBe(
    git(src, "rev-parse", "HEAD"),
  );
  for (const c of forge.calls()) {
    for (const arg of c.args) expect(arg).not.toContain(TOKEN);
  }
  expect(JSON.stringify(w.logs)).not.toContain(TOKEN);
});
