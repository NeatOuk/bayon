import { describe, expect, test } from "vitest";
import {
  KEPT_DETAIL_CAP,
  WorktreeKeptReason,
  capDetail,
  disposableIgnored,
  foremanPacketsOnly,
  headFate,
  hiddenIndexBits,
  isStaleCloneName,
  isSweepable,
  parseLsFilesStageZ,
  parseStatusZ,
  removable,
  sweepVerdict,
  sweepVisit,
  type SweepRow,
} from "./sweep.js";

// The sweep's pure rules: every branch, as tables.
const ROW: SweepRow = {
  executorKind: "local",
  holderId: "s1",
  holderState: "exited",
  holderEndedAt: 1_000,
  holderGateId: null,
  ticketId: "t1",
  ticketStatus: "done",
  unacceptedHandoff: false,
  liveSuccessor: false,
};
const NONE = new Set<string>();

describe("sweepVisit (§3 rules 1–5)", () => {
  test.each([
    ["an exited local holder", {}, NONE, null],
    ["a handed-off holder", { holderState: "handed_off" }, NONE, null],
    ["a container row", { executorKind: "container" }, NONE, "not_local"],
    ["an unknown executor", { executorKind: null }, NONE, "not_local"],
    ["no holder", { holderId: null }, NONE, "no_holder"],
    ["a holder state unknown", { holderState: null }, NONE, "no_holder"],
    [
      "a resumable holder",
      { holderState: "resumable" },
      NONE,
      "holder_not_ended",
    ],
    ["an idle holder", { holderState: "idle" }, NONE, "holder_not_ended"],
    ["a holder still live here", {}, new Set(["s1"]), "holder_live"],
    [
      "a hand-off on an open ticket",
      { unacceptedHandoff: true, ticketStatus: "building" },
      NONE,
      "held",
    ],
    [
      "a hand-off on a ticketless row",
      { unacceptedHandoff: true, ticketId: null, ticketStatus: null },
      NONE,
      "held",
    ],
    ["a hand-off on a done ticket", { unacceptedHandoff: true }, NONE, null],
    [
      "a hand-off on a split ticket",
      { unacceptedHandoff: true, ticketStatus: "split" },
      NONE,
      null,
    ],
    [
      "a hand-off on a done ticket with a live successor",
      { unacceptedHandoff: true, liveSuccessor: true },
      NONE,
      "held",
    ],
  ] as const)("%s", (_, patch, live, want) => {
    expect(sweepVisit({ ...ROW, ...patch }, live)).toBe(want);
  });
});

describe("removable (§3, M2, M5, NEW-7)", () => {
  const NOW = 10_000;
  test.each([
    ["a done ticket ended long ago", {}, null],
    ["a rejected ticket", { ticketStatus: "rejected" }, null],
    ["a split ticket", { ticketStatus: "split" }, null],
    // Sweepable since an earlier change: without this, close_out (parked → done) could never clear its own
    // no_active_worktree requirement, since parked was otherwise stuck alongside "open" tickets.
    ["a parked ticket", { ticketStatus: "parked" }, null],
    ["an open ticket", { ticketStatus: "building" }, "ticket_open"],
    ["a blocked ticket", { ticketStatus: "blocked" }, "ticket_open"],
    [
      "a reviewer on an open ticket",
      { ticketStatus: "building", holderGateId: "g1" },
      null,
    ],
    ["a ticketless row", { ticketId: null, ticketStatus: null }, null],
    ["no ended_at", { holderEndedAt: null }, "no_ended_at"],
    ["ended exactly min_ended_ms ago", { holderEndedAt: NOW - 5_000 }, null],
    ["ended too recently", { holderEndedAt: NOW - 4_999 }, "ended_recently"],
  ] as const)("%s", (_, patch, want) => {
    expect(removable({ ...ROW, ...patch }, NOW, 5_000)).toBe(want);
  });
});

test("isSweepable: done, rejected, split, parked", () => {
  expect(["done", "rejected", "split", "parked"].map(isSweepable)).toEqual([
    true,
    true,
    true,
    true,
  ]);
  expect(isSweepable("building")).toBe(false);
  expect(isSweepable(null)).toBe(false);
});

describe("headFate (§5.1, M1, NEW-2)", () => {
  test.each([
    ["on the base", { onBase: true }, "merged"],
    [
      "a reviewer on a shared ref",
      { reviewer: true, onSharedRef: true },
      "merged",
    ],
    ["a reviewer's own commit", { reviewer: true }, "unpublished"],
    ["a builder, open ticket", { onSharedRef: true }, "unmerged"],
    [
      "a builder on its own branch, done ticket",
      { sweepable: true, onSharedRef: true },
      "own_branch",
    ],
    ["a detached commit, done ticket", { sweepable: true }, "unpublished"],
  ] as const)("%s", (_, patch, want) => {
    expect(
      headFate({
        reviewer: false,
        sweepable: false,
        onBase: false,
        onSharedRef: false,
        ...patch,
      }),
    ).toBe(want);
  });
});

describe("disposableIgnored (Q5, N2)", () => {
  const NAMES = [
    "node_modules/",
    "dist/",
    ".DS_Store",
    ".foreman/",
    "",
    "a/b/",
  ];
  test.each([
    ["node_modules/", true],
    ["pkg/node_modules/", true],
    ["pkg/node_modules/x/y.js", true],
    ["dist/", true],
    ["src/dist.js", false],
    ["dist", false],
    [".DS_Store", true],
    ["deep/.DS_Store", true],
    [".DS_Store/", false],
    ["secret.txt", false],
    ["build/", false],
    [".foreman/", false],
    ["a/b/", false],
    ["../node_modules/", false],
    ["./node_modules/", false],
    ["/", false],
    ["", false],
  ])("%s → %s", (entry, want) => {
    expect(disposableIgnored(entry, NAMES)).toBe(want);
  });
});

test("foremanPacketsOnly: only handoff-<n>.md and the context store", () => {
  expect(foremanPacketsOnly(["handoff-1.md", "handoff-12.md"])).toBe(true);
  expect(foremanPacketsOnly([])).toBe(true);
  expect(foremanPacketsOnly(["handoff-1.md", "notes.md"])).toBe(false);
  expect(foremanPacketsOnly(["handoff-.md"])).toBe(false);
  // The store of compressed tool results' originals is disposable (M12).
  expect(foremanPacketsOnly(["ctx"])).toBe(true);
  expect(foremanPacketsOnly(["handoff-1.md", "ctx"])).toBe(true);
  expect(foremanPacketsOnly(["ctx", "notes.md"])).toBe(false);
  for (const near of ["ctx2", "Ctx", "ctx.bak", "xctx"]) {
    expect(foremanPacketsOnly([near])).toBe(false);
  }
});

test("parseStatusZ: codes and paths, a rename's source skipped", () => {
  const out = [
    " M a.txt",
    "?? new dir/",
    "R  to.txt",
    "from.txt",
    "!! node_modules/",
    "",
    "x",
  ].join("\0");
  expect(parseStatusZ(out)).toEqual([
    { code: " M", path: "a.txt" },
    { code: "??", path: "new dir/" },
    { code: "R ", path: "to.txt" },
    { code: "!!", path: "node_modules/" },
  ]);
  expect(parseStatusZ("")).toEqual([]);
});

test("hiddenIndexBits: lowercase tags and S, nothing else", () => {
  const out = ["H .gitignore", "h a", "S b", "s c", "? d", "M e", "", "z"].join(
    "\0",
  );
  expect(hiddenIndexBits(out)).toEqual(["a", "b", "c"]);
});

test("parseLsFilesStageZ: mode and path", () => {
  const out = [
    "100644 abc 0\tsrc/a.ts",
    "160000 def 0\tlibs/mid",
    "noise",
    "",
  ].join("\0");
  expect(parseLsFilesStageZ(out)).toEqual([
    { mode: "100644", path: "src/a.ts" },
    { mode: "160000", path: "libs/mid" },
  ]);
});

test("isStaleCloneName: .<base>.clone- and six alphanumerics, nothing else", () => {
  expect(isStaleCloneName(".repo.git.clone-Ab12Cd", "repo.git")).toBe(true);
  expect(isStaleCloneName(".repo.git.clone-Ab12Cde", "repo.git")).toBe(false);
  expect(isStaleCloneName(".repo.git.clone-Ab12C", "repo.git")).toBe(false);
  expect(isStaleCloneName(".other.git.clone-Ab12Cd", "repo.git")).toBe(false);
  expect(isStaleCloneName("repo.git", "repo.git")).toBe(false);
  expect(isStaleCloneName(".repo.git.clone-Ab12C/", "repo.git")).toBe(false);
});

test("capDetail: at most KEPT_DETAIL_CAP characters", () => {
  expect(capDetail("short")).toBe("short");
  const long = capDetail("x".repeat(KEPT_DETAIL_CAP + 10));
  expect(long).toHaveLength(KEPT_DETAIL_CAP);
  expect(long.endsWith("…")).toBe(true);
  expect(capDetail("y".repeat(KEPT_DETAIL_CAP))).toHaveLength(KEPT_DETAIL_CAP);
});

describe("sweepVerdict", () => {
  const BASE = {
    flag: null,
    publishable: true,
    notRemovable: null,
    removalOn: true,
  } as const;
  test.each([
    ["a clean, publishable, removable row", {}, { kind: "remove" }],
    [
      "a flag",
      { flag: { reason: "dirty", detail: "a.txt" } },
      { kind: "flag", reason: "dirty", detail: "a.txt" },
    ],
    [
      "not publishable",
      { publishable: false },
      { kind: "keep", why: "unmerged" },
    ],
    [
      "not removable",
      { notRemovable: "ticket_open" },
      { kind: "keep", why: "ticket_open" },
    ],
    ["removal off", { removalOn: false }, { kind: "keep", why: "removal_off" }],
  ] as const)("%s", (_, patch, want) => {
    expect(sweepVerdict({ ...BASE, ...patch })).toEqual(want);
  });
});

test("WorktreeKeptReason: the six reasons 015's CHECK allows", () => {
  expect(WorktreeKeptReason.options).toEqual([
    "dirty",
    "ignored",
    "locked",
    "unpublished",
    "unverifiable",
    "remove_failed",
  ]);
});
