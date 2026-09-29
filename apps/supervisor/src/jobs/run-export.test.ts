import { FakeClock } from "@bayon/core";
import { expect, test } from "vitest";
import type { CommitOutcome, GitStep } from "./git-export.js";
import type {
  ExportDeps,
  ExportFs,
  ExportMission,
  ExportTicket,
} from "./run-export.js";
import { runExport } from "./run-export.js";

function fakeFs(initial: Readonly<Record<string, string>> = {}): ExportFs & {
  readonly files: Map<string, string>;
  readonly writes: string[];
  readonly unlinks: string[];
} {
  const files = new Map(Object.entries(initial));
  const writes: string[] = [];
  const unlinks: string[] = [];
  return {
    files,
    writes,
    unlinks,
    readFile: async (path) => files.get(path),
    writeFile: async (path, content) => {
      writes.push(path);
      files.set(path, content);
    },
    readdir: async (dir) => {
      const prefix = `${dir}/`;
      return [...files.keys()]
        .filter(
          (p) => p.startsWith(prefix) && !p.slice(prefix.length).includes("/"),
        )
        .map((p) => p.slice(prefix.length));
    },
    unlink: async (path) => {
      unlinks.push(path);
      files.delete(path);
    },
  };
}

const OK_COMMIT = (committed: boolean): CommitOutcome => ({
  committed,
  steps: [] as GitStep[],
});

function deps(overrides: Partial<ExportDeps> = {}, fs = fakeFs()): ExportDeps {
  return {
    listTickets: async () => [],
    listMissions: async () => [],
    fs,
    ensureRepo: async () => ({ ok: true }),
    commit: async () => ({ ok: true, value: OK_COMMIT(false) }),
    clock: new FakeClock(0),
    exportsDir: "/exports",
    keyPrefix: "T-",
    ...overrides,
  };
}

const ticket = (
  num: number,
  overrides: Partial<ExportTicket["view"]> = {},
): ExportTicket => ({
  id: `tkt-${num}`,
  num,
  view: {
    title: `Ticket ${num}`,
    status: "backlog",
    type: "feature",
    tier: "standard",
    priority: 3,
    costUsd: 0,
    branch: null,
    prUrl: null,
    bodyMd: "body",
    acceptanceMd: "acceptance",
    ...overrides,
  },
});

test("first run: writes every ticket, commits, non-empty manifest", async () => {
  const commits: string[] = [];
  const fs = fakeFs();
  const result = await runExport(
    deps(
      {
        listTickets: async () => [ticket(1), ticket(2)],
        commit: async (_repo, message) => {
          commits.push(message);
          return { ok: true, value: OK_COMMIT(true) };
        },
      },
      fs,
    ),
  );
  expect(result).toMatchObject({ outcome: "ok", committed: true });
  expect(result.manifest.entries).toHaveLength(2);
  expect(fs.writes).toEqual([
    "/exports/tickets/T-1.md",
    "/exports/tickets/T-2.md",
  ]);
  expect(commits[0]).toContain("2 ticket(s)");
});

test("second run, nothing changed: no writes, empty manifest, commit still called but reports no commit", async () => {
  const fs = fakeFs();
  const listTickets = async () => [ticket(1)];
  const first = await runExport(
    deps(
      {
        listTickets,
        commit: async () => ({ ok: true, value: OK_COMMIT(true) }),
      },
      fs,
    ),
  );
  expect(first.manifest.entries).toHaveLength(1);
  fs.writes.length = 0;

  let commitCalls = 0;
  const second = await runExport(
    deps(
      {
        listTickets,
        commit: async () => {
          commitCalls += 1;
          return { ok: true, value: OK_COMMIT(false) };
        },
      },
      fs,
    ),
  );
  expect(second).toMatchObject({ outcome: "ok", committed: false });
  expect(second.manifest.entries).toEqual([]);
  expect(second.manifest.removed).toEqual([]);
  expect(fs.writes).toEqual([]);
  expect(commitCalls).toBe(1);
});

test("a changed ticket is rewritten; an untouched one is not", async () => {
  const fs = fakeFs();
  await runExport(
    deps({ listTickets: async () => [ticket(1), ticket(2)] }, fs),
  );
  fs.writes.length = 0;

  const result = await runExport(
    deps(
      { listTickets: async () => [ticket(1, { title: "Renamed" }), ticket(2)] },
      fs,
    ),
  );
  expect(fs.writes).toEqual(["/exports/tickets/T-1.md"]);
  expect(result.manifest.entries.map((e) => e.ticket_id)).toEqual(["tkt-1"]);
});

test("a key_prefix change orphans the old file and it is deleted and reported", async () => {
  const fs = fakeFs();
  await runExport(
    deps({ listTickets: async () => [ticket(1)], keyPrefix: "T-" }, fs),
  );
  expect(fs.files.has("/exports/tickets/T-1.md")).toBe(true);

  const result = await runExport(
    deps({ listTickets: async () => [ticket(1)], keyPrefix: "NEW-" }, fs),
  );
  expect(fs.unlinks).toEqual(["/exports/tickets/T-1.md"]);
  expect(fs.files.has("/exports/tickets/T-1.md")).toBe(false);
  expect(fs.files.has("/exports/tickets/NEW-1.md")).toBe(true);
  expect(result.manifest.removed).toEqual(["T-1.md"]);
});

test("an unsafe key_prefix fails the run instead of touching the filesystem", async () => {
  const fs = fakeFs();
  const result = await runExport(
    deps({ listTickets: async () => [ticket(1)], keyPrefix: "../../etc" }, fs),
  );
  expect(result.outcome).toBe("failed");
  expect(fs.writes).toEqual([]);
});

test("an unsafe mission agent name fails the run instead of touching the filesystem", async () => {
  const fs = fakeFs();
  const result = await runExport(
    deps(
      {
        listMissions: async () => [
          { agentName: "../escape", version: 1, renderedMd: "x" },
        ],
      },
      fs,
    ),
  );
  expect(result.outcome).toBe("failed");
  expect(fs.writes).toEqual([]);
});

test("missions are written once, verbatim, and never rewritten once present", async () => {
  const fs = fakeFs();
  const mission: ExportMission = {
    agentName: "builder",
    version: 1,
    renderedMd: "# Mission\n",
  };
  await runExport(deps({ listMissions: async () => [mission] }, fs));
  expect(fs.files.get("/exports/mission/builder/v01.md")).toBe("# Mission\n");

  fs.writes.length = 0;
  await runExport(deps({ listMissions: async () => [mission] }, fs));
  expect(fs.writes).toEqual([]);
});

test("ensureRepo failing short-circuits before any read or write", async () => {
  let listed = false;
  const result = await runExport(
    deps({
      ensureRepo: async () => ({ ok: false, error: "not our repo" }),
      listTickets: async () => {
        listed = true;
        return [ticket(1)];
      },
    }),
  );
  expect(result).toMatchObject({ outcome: "failed", error: "not our repo" });
  expect(listed).toBe(false);
});

test("a failing commit still returns the manifest that was rendered", async () => {
  const result = await runExport(
    deps({
      listTickets: async () => [ticket(1)],
      commit: async () => ({
        ok: false,
        error: "git commit failed",
        steps: [],
      }),
    }),
  );
  expect(result.outcome).toBe("failed");
  expect(result.error).toBe("git commit failed");
  expect(result.manifest.entries).toHaveLength(1);
});

test("a throwing read is reported as failed, never thrown out of runExport", async () => {
  const result = await runExport(
    deps({
      listTickets: async () => {
        throw new Error("db exploded");
      },
    }),
  );
  expect(result).toMatchObject({ outcome: "failed", error: "db exploded" });
});
