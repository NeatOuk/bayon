// claimHome where the home is its executor's, not this host's: one fixed program run
// through Executor.exec. The stand-in executor runs on this host but claims as a container does.
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalExecutor, SlotCounter, type Executor } from "@bayon/executors";
import { afterAll, expect, test } from "vitest";
import { HOME_LOCK, claimHome } from "./home.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "frm-claim-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
const local = new LocalExecutor({ id: "local", slots: new SlotCounter(2) });
const remote: Executor = {
  id: "ctr-stand-in",
  kind: "container",
  capabilities: { pty: false },
  envPath: "/usr/bin:/bin",
  prepare: (spec) => local.prepare(spec),
  exec: (argv, opts) => local.exec(argv, opts),
  pty: (argv, opts) => local.pty(argv, opts),
  probe: (ref) => local.probe(ref),
  cleanup: (ref, mode) => local.cleanup(ref, mode),
  capacity: () => local.capacity(),
  health: (limits) => local.health(limits),
};

test("a remote home is claimed through its executor: once, again by the same session, never by another", async () => {
  mkdirSync(join(base, "S1", ".frm"), { recursive: true });
  const home = join(base, "S1", ".frm", "home");
  expect(await claimHome(home, "S1", remote)).toEqual({
    ok: true,
    value: { files: [join(home, HOME_LOCK)] },
  });
  expect(readFileSync(join(home, HOME_LOCK), "utf8")).toBe("S1");
  expect((await claimHome(home, "S1", remote)).ok).toBe(true);
  expect(await claimHome(home, "S2", remote)).toMatchObject({
    ok: false,
    error: {
      class: "conflict",
      message: expect.stringContaining("belongs to session S1"),
    },
  });
});

test("a claim that cannot start is internal", async () => {
  expect(
    await claimHome(join(base, "missing", ".frm", "home"), "S9", remote),
  ).toMatchObject({ ok: false, error: { class: "internal" } });
});
