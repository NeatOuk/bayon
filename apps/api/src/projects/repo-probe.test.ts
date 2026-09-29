// Checking a repo URL before a project is created. The command-backed probe against a
// real temp database, with the test in the supervisor's place, and ProjectsService with a stubbed
// probe: refused in plain words and nothing written, the default branch taken, and a project still
// created, with a warning, when the supervisor does not answer.
import { FakeClock, ok, type RepoCheckResult, type Result } from "@bayon/core";
import { getRepo } from "@bayon/db";
import {
  seedRows,
  seedSpine,
  tempDb,
  unwrap,
  type TempDb,
} from "@bayon/db/testing";
import type { CommandView, CreateProjectRequest } from "@bayon/proto";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { dbStore } from "../db-store.js";
import type { ApiStore } from "../store.js";
import { ProjectsService } from "./projects-service.js";
import {
  REPO_PROBE_WAIT_MS,
  commandRepoProbe,
  repoCheckKey,
  type RepoProbe,
} from "./repo-probe.js";

const T0 = 1_700_000_000_000;
const URL_ = "https://github.com/acme/shop.git";

let t: TempDb;
beforeEach(async () => {
  t = unwrap(await tempDb(new FakeClock(T0)));
  unwrap(await seedSpine(t.db, 1));
});
afterEach(() => t.cleanup());

const found = (r: Partial<RepoCheckResult> = {}): RepoCheckResult => ({
  outcome: "found",
  default_branch: "trunk",
  base_found: null,
  token_secret: "FORGE_TOKEN_GITHUB",
  token_offered: false,
  detail: "",
  ...r,
});

/**
 * The real store inserts the command; the supervisor's side (which apps/api may not import) is a
 * view of the row as the claimer would leave it, served from the second read on.
 */
function probe(answer?: Pick<CommandView, "state" | "result" | "error">) {
  const clock = new FakeClock(T0);
  const real = dbStore(t.db);
  const inserted: string[] = [];
  let reads = 0;
  const store: Pick<ApiStore, "insertCommand" | "command"> = {
    insertCommand: async (c) => {
      const r = await real.insertCommand(c);
      if (r.ok) inserted.push(r.value.id);
      return r;
    },
    command: async (id) => {
      const row = await real.command(id);
      reads += 1;
      return row.ok && answer !== undefined && reads > 1
        ? ok({ ...row.value, ...answer })
        : row;
    },
  };
  return { clock, inserted, probe: commandRepoProbe({ store, clock }) };
}

/** Lets the probe read the row again. */
const tick = async (clock: FakeClock) => {
  await new Promise((resolve) => setImmediate(resolve));
  await clock.advance(250);
};

describe("commandRepoProbe", () => {
  test("inserts repo.check and returns the supervisor's recorded answer", async () => {
    const p = probe({
      state: "done",
      result: found({ base_found: true }),
      error: null,
    });
    const pending = p.probe.check(URL_, "dev");
    await tick(p.clock);
    expect(await pending).toEqual(ok(found({ base_found: true })));
    const row = unwrap(await dbStore(t.db).command(p.inserted[0] ?? ""));
    expect(row).toMatchObject({
      type: "repo.check",
      state: "pending",
      payload: { url: URL_, base: "dev" },
    });
  });

  test("a failed check is its error", async () => {
    const p = probe({
      state: "failed",
      result: null,
      error: { class: "validation", message: "bad url", retryable: false },
    });
    const pending = p.probe.check(URL_, "dev");
    await tick(p.clock);
    expect(await pending).toMatchObject({
      ok: false,
      error: { class: "validation", message: "bad url" },
    });
  });

  test("a result that does not parse is internal, not a guess", async () => {
    const p = probe({
      state: "done",
      result: { outcome: "maybe" },
      error: null,
    });
    const pending = p.probe.check(URL_);
    await tick(p.clock);
    expect(await pending).toMatchObject({
      ok: false,
      error: { class: "internal" },
    });
  });

  test("no answer within the wait is null: nothing was checked", async () => {
    const p = probe();
    let settled: Result<RepoCheckResult | null> | undefined;
    void p.probe.check(URL_).then((r) => (settled = r));
    // Past the wait, a second at a time: each advance lets the probe read the row once more.
    while (
      settled === undefined &&
      p.clock.now() - T0 <= REPO_PROBE_WAIT_MS + 1_000
    ) {
      await p.clock.advance(1_000);
      await new Promise((resolve) => setImmediate(resolve));
    }
    expect(settled).toEqual(ok(null));
    expect(p.clock.now() - T0).toBeGreaterThanOrEqual(REPO_PROBE_WAIT_MS);
  });
});

describe("a check is shared, not repeated (review H1)", () => {
  test("the key is the hashed URL and base, and the minute", () => {
    const key = repoCheckKey(URL_, "dev", T0);
    expect(key).toMatch(/^repo\.check:[0-9a-f]{64}:\d+$/);
    expect(key).not.toContain("github");
    expect(repoCheckKey(URL_, "dev", T0 + 1_000)).toBe(
      repoCheckKey(URL_, "dev", Math.floor(T0 / 60_000) * 60_000),
    );
    expect(repoCheckKey(URL_, "dev", T0 + 60_000)).not.toBe(key);
    expect(repoCheckKey(URL_, undefined, T0)).not.toBe(key);
  });

  test("two checks of the same URL and base in the same minute wait on one command", async () => {
    const clock = new FakeClock(T0);
    const real = dbStore(t.db);
    const created: string[] = [];
    const store: Pick<ApiStore, "insertCommand" | "command"> = {
      insertCommand: async (c) => {
        const r = await real.insertCommand(c);
        if (r.ok && r.value.created) created.push(r.value.id);
        return r;
      },
      command: (id) => real.command(id),
    };
    const probe = commandRepoProbe({ store, clock, waitMs: 1_000 });
    const first = probe.check(URL_, "dev");
    const second = probe.check(URL_, "dev");
    await new Promise((resolve) => setImmediate(resolve));
    await clock.advance(2_000);
    expect(await first).toEqual(ok(null));
    expect(await second).toEqual(ok(null));
    expect(created).toHaveLength(1);
    // Another base, or the next minute, is its own check.
    const other = probe.check(URL_, "main");
    await new Promise((resolve) => setImmediate(resolve));
    await clock.advance(2_000);
    await other;
    expect(created).toHaveLength(2);
  });

  test("a shared check the supervisor refused as busy is asked again, unkeyed", async () => {
    const busy = probe({
      state: "failed",
      result: null,
      error: { class: "admission_refused", message: "busy", retryable: true },
    });
    // The first check records busy for the minute's key.
    const pending = busy.probe.check(URL_, "dev");
    await tick(busy.clock);
    expect(await pending).toMatchObject({
      ok: false,
      error: { class: "admission_refused", retryable: true },
    });
    const next = busy.probe.check(URL_, "dev");
    await tick(busy.clock);
    await next;
    expect(new Set(busy.inserted).size).toBe(2);
  });
});

describe("ProjectsService with a repo probe", () => {
  const REQUEST: CreateProjectRequest = {
    name: "shop",
    repo_url: URL_,
    runner_id: "fixture",
    executor_id: "local",
    orchestrator: false,
  };

  function service(answer: RepoCheckResult | null) {
    const asked: { url: string; base: string | undefined }[] = [];
    const repoProbe: RepoProbe = {
      check: (url, base) => {
        asked.push({ url, base });
        return Promise.resolve(ok(answer));
      },
    };
    return {
      asked,
      projects: new ProjectsService({
        db: t.db,
        clock: new FakeClock(T0),
        mirrorsRoot: "/home/frm/mirrors",
        repoProbe,
        storeHint: { kind: "keychain", service: "foreman" },
      }),
    };
  }

  test("a repository that cannot be read is refused in plain words, naming the fix, and nothing is written", async () => {
    const s = service(
      found({ outcome: "missing", default_branch: null, detail: "x" }),
    );
    const refused = await s.projects.create(REQUEST);
    expect(refused).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    if (!refused.ok) {
      expect(refused.error.message).toContain(
        `Bayon cannot read ${URL_}: the repository does not exist, or it is private`,
      );
      expect(refused.error.message).toContain(
        "Run: security add-generic-password -U -s foreman -a FORGE_TOKEN_GITHUB -w",
      );
    }
    expect(await getRepo(t.db, "shop")).toMatchObject({
      ok: false,
      error: { class: "not_found" },
    });
  });

  test("a repository found takes its default branch as the base when none was asked", async () => {
    const s = service(found());
    const created = unwrap(await s.projects.create(REQUEST));
    expect(created.warnings).toEqual([]);
    expect(unwrap(await getRepo(t.db, "shop")).default_base_branch).toBe(
      "trunk",
    );
    expect(s.asked).toEqual([{ url: URL_, base: undefined }]);
  });

  test("an asked base the remote does not have is refused, naming the default", async () => {
    const s = service(found({ base_found: false }));
    const refused = await s.projects.create({
      ...REQUEST,
      base_branch: "main",
    });
    expect(refused).toMatchObject({
      ok: false,
      error: { class: "validation" },
    });
    if (!refused.ok) {
      expect(refused.error.message).toBe(
        `${URL_} has no branch main. Its default branch is trunk. Leave the base branch empty to use the default, or give one the repository has.`,
      );
    }
  });

  test("no answer from the supervisor still creates the project, with a warning", async () => {
    const created = unwrap(await service(null).projects.create(REQUEST));
    expect(created.warnings).toEqual([
      `Bayon has not checked ${URL_}: the supervisor did not answer. Is it running? The first session will clone it, and say why if that fails.`,
    ]);
    expect(unwrap(await getRepo(t.db, "shop")).default_base_branch).toBe(
      "main",
    );
  });

  test("checkRepo says what the create would, and refuses a folder or a malformed URL", async () => {
    const s = service(
      found({ outcome: "host_key", default_branch: null, token_secret: null }),
    );
    expect(
      unwrap(
        await s.projects.checkRepo({ repo_url: "git@git.example.com:a/b.git" }),
      ),
    ).toEqual({
      ok: false,
      outcome: "host_key",
      message: expect.stringContaining(
        "does not know git.example.com's ssh host key",
      ),
      default_branch: null,
      command: "ssh-keyscan git.example.com >> ~/.ssh/known_hosts",
    });
    expect(await s.projects.checkRepo({ repo_url: "/srv/code" })).toMatchObject(
      {
        ok: false,
        error: { class: "validation" },
      },
    );
    expect(await s.projects.checkRepo({ repo_url: "ftp://x/y" })).toMatchObject(
      {
        ok: false,
        error: { class: "validation" },
      },
    );
  });

  test("a private host is refused until projects.private_repo_hosts lists it, and only then probed (review M2)", async () => {
    const s = service(found());
    const lan = "https://git.lan/a/b.git";
    const refused = await s.projects.checkRepo({
      repo_url: "https://10.0.0.7/a/b.git",
    });
    expect(refused).toMatchObject({
      ok: false,
      error: {
        class: "validation",
        message: expect.stringContaining(
          "pnpm frm settings set projects.private_repo_hosts 10.0.0.7 --yes",
        ),
      },
    });
    expect(s.asked).toEqual([]);
    unwrap(
      await seedRows(t.db, {
        settings: [
          {
            key: "projects.private_repo_hosts",
            value_json: JSON.stringify(["10.0.0.7"]),
            updated_at: T0,
          },
        ],
      }),
    );
    expect(
      unwrap(
        await s.projects.checkRepo({ repo_url: "https://10.0.0.7/a/b.git" }),
      ).ok,
    ).toBe(true);
    // A public name is not judged by the API's literal check; the supervisor resolves it.
    expect(unwrap(await s.projects.checkRepo({ repo_url: lan })).ok).toBe(true);
    expect(s.asked.map((a) => a.url)).toEqual([
      "https://10.0.0.7/a/b.git",
      lan,
    ]);
  });

  test("no credential reaches a refusal: a URL's userinfo is dropped", async () => {
    const s = service(found({ outcome: "unreachable", default_branch: null }));
    const refused = await s.projects.create({
      ...REQUEST,
      repo_url: "https://bob:s3cret@git.example.com/a/b.git",
    });
    expect(refused.ok).toBe(false);
    expect(JSON.stringify(refused)).not.toContain("s3cret");
  });
});
