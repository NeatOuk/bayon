// A gate's subject pin on a repo whose origin is a private https repository: the base
// fetch is offered the forge token when FORGE_TOKEN_GITHUB is in the store, and without it the pin
// fails `internal`, as a failed fetch on the gate path always has.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock, forgeTokenSecret, ok } from "@bayon/core";
import { getTicket } from "@bayon/db";
import { seedRows, tempDb, unwrap, type SeedRows } from "@bayon/db/testing";
import { afterAll, describe, expect, test } from "vitest";
import { envSecrets } from "../lifecycle/secrets.js";
import { KeyedQueue } from "../lifecycle/session-queue.js";
import { DEFAULT_SETTINGS } from "../lifecycle/settings.js";
import { FORGE_URL, standInForge } from "../lifecycle/testing/forge-remote.js";
import {
  T0,
  TICKET,
  TURN,
  git,
  kindsOf,
  makeSource,
  multiRows,
  repoRow,
  settle,
  startMultiWorld,
  type MultiWorld,
} from "../lifecycle/testing/multi-world.js";
import { pinSubject, type PinInput } from "./subject.js";

const TOKEN = "ghp_pin_standin_84be";
const SECRET = { [`FRM_SECRET_${forgeTokenSecret("github")}`]: TOKEN };
const silent = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

const dirs: string[] = [];
let w: MultiWorld | undefined;
afterAll(async () => {
  await w?.cleanup();
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

describe(
  "pinning a subject whose origin is private https",
  { timeout: 60_000 },
  () => {
    const pre = mkdtempSync(join(tmpdir(), "frm-pin-forge-"));
    dirs.push(pre);
    const lib = makeSource(pre, "lib");
    const forge = standInForge({ dir: pre, source: lib, token: TOKEN });

    const input = async (
      world: MultiWorld,
      withSecret: boolean,
    ): Promise<PinInput> => {
      const artifactsDir = mkdtempSync(join(tmpdir(), "frm-pin-"));
      dirs.push(artifactsDir);
      const g = {
        exec: {
          settings: DEFAULT_SETTINGS,
          clock: world.clock,
          frmHome: world.home,
          path: forge.path,
          log: silent,
        },
        executor: world.executor,
      };
      return {
        db: world.db,
        git: g,
        gitOn: () => ok(g),
        ticket: unwrap(await getTicket(world.db, TICKET)),
        gateId: "g-pin",
        kind: "code_review",
        repoId: "lib",
        subjectKind: "diff",
        artifactsDir,
        mirrors: new KeyedQueue(),
        ...(withSecret ? { secrets: envSecrets(SECRET) } : {}),
      };
    };

    test("setup: a builder commits in lib, cloned from the forge with the token", async () => {
      const clock = new FakeClock(T0);
      const t = unwrap(await tempDb(clock));
      w = await startMultiWorld({
        clock,
        db: t.db,
        dropDb: t.cleanup,
        seed: async (rows) => {
          unwrap(await seedRows(t.db, rows as SeedRows));
        },
        rows: (home) => {
          const made = multiRows(home);
          return {
            ...made.rows,
            repos: made.rows.repos.map((r) =>
              r.id === "lib" ? repoRow(home, "lib", FORGE_URL) : r,
            ),
          };
        },
        path: forge.path,
        secrets: SECRET,
        script: (home) => ({
          runs: [
            {
              events: [TURN],
              appends: [
                {
                  path: join(home, "work", "B", "lib", "lib.js"),
                  text: "code\n",
                },
              ],
              commit: "a change in lib",
            },
          ],
        }),
      });
      const world = w;
      await world.spawn("B", { prompt: "go" });
      await settle(world, async () =>
        expect(await kindsOf(world.db, "B")).toContain("terminal"),
      );
    });

    test("with FORGE_TOKEN_GITHUB in the store, the base fetch is offered the token", async () => {
      const world = w as MultiWorld;
      const before = forge.calls().length;
      const pin = await pinSubject(await input(world, true));
      expect(pin).toMatchObject({ ok: true, value: { repoId: "lib" } });
      const fetches = forge
        .calls()
        .slice(before)
        .filter((c) => c.args.includes("fetch"));
      expect(fetches.length).toBeGreaterThan(0);
      expect(fetches.every((c) => c.tokenInEnv)).toBe(true);
      for (const c of forge.calls()) {
        for (const arg of c.args) expect(arg).not.toContain(TOKEN);
      }
      if (pin.ok) {
        expect(pin.value.base).toBe(git(lib, "rev-parse", "HEAD"));
      }
    });

    test("without it, the pin fails `internal`, as a failed gate fetch always has", async () => {
      const world = w as MultiWorld;
      const pin = await pinSubject(await input(world, false));
      expect(pin).toMatchObject({ ok: false, error: { class: "internal" } });
      if (!pin.ok) {
        expect(pin.error.message).toContain("could not read Username");
        expect(pin.error.message).not.toContain(TOKEN);
      }
    });
  },
);
