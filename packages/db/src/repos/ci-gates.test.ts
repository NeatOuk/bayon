// What the CI sweep reads and writes, against a real temp database: the running gates
// that wait on CI (by the subject they opened with, never by the project's mode now), one gate's
// plan, and the progress it records — only when it changed.
import { FakeClock } from "@bayon/core";
import { afterEach, expect, test } from "vitest";
import {
  dumpAllRows,
  seedRows,
  tempDb,
  unwrap,
  type TempDb,
} from "../testing.js";
import { ciGatePlan, listCiGates, recordCiProgress } from "./ci-gates.js";

const opened: TempDb[] = [];
afterEach(() => {
  for (const t of opened.splice(0)) t.cleanup();
});

const HEAD = "a".repeat(40);

const gate = (
  id: string,
  ticket: string,
  o: {
    kind?: "qa_harness" | "code_review";
    state?: "running" | "failed";
    subject?: string;
    started?: number;
    attempt?: number;
  } = {},
) => ({
  id,
  ticket_id: ticket,
  kind: o.kind ?? ("qa_harness" as const),
  state: o.state ?? ("running" as const),
  attempt: o.attempt ?? 1,
  subject_kind: o.subject ?? "pull_request",
  subject_ref: "unpinned",
  started_at: o.started ?? 10,
});

async function fresh(checks: string | null = null) {
  const t = unwrap(await tempDb(new FakeClock(1_700_000_000_000)));
  opened.push(t);
  unwrap(
    await seedRows(t.db, {
      workspaces: [
        {
          id: "W",
          name: "W",
          kind: "single",
          qa_mode: "ci",
          qa_ci_checks_json: checks,
          qa_ci_timeout_ms: 1_800_000,
          delivery_mode: "pull_request",
          delivery_when: "review_passed",
        },
      ],
      repos: [{ id: "r1", name: "r1", mirror_path: "/m/r1.git" }],
      workspace_repos: [
        { workspace_id: "W", repo_id: "r1", rel_path: "r1", role: "primary" },
      ],
      tickets: [1, 2, 3, 4].map((num) => ({
        id: `T${String(num)}`,
        num,
        title: "t",
        type: "chore" as const,
        status: num === 4 ? "qa_human" : "qa_harness",
        origin: "operator",
        workspace_id: "W",
        created_at: 1,
        updated_at: 1,
      })),
      gates: [
        gate("G1", "T1", { started: 30 }),
        gate("G2", "T2", { started: 20 }),
        gate("G2b", "T2", { started: 20, attempt: 2 }),
        // Not the CI sweep's: a command harness, a decided gate.
        gate("G3", "T3", { subject: "workspace" }),
        gate("G3b", "T3", { state: "failed", attempt: 2 }),
        // Its ticket is off qa_harness (review MEDIUM 2), but the gate runs: it is still judged.
        gate("G4", "T4", { started: 40 }),
      ],
      deliveries: [
        {
          id: "D1",
          ticket_id: "T1",
          repo_id: "r1",
          branch: "frm/s",
          head_sha: HEAD,
          state: "pr_open" as const,
          pr_url: "https://forge.test/pull/1",
          pr_number: 1,
          started_at: 1,
        },
      ],
    }),
  );
  return t.db;
}

test("every running CI gate, whatever its ticket's status, by start then id, paged from a cursor", async () => {
  const db = await fresh();
  const all = unwrap(await listCiGates(db, { limit: 10, after: null }));
  expect(all.map((g) => [g.id, g.ticket_id, g.started_at])).toEqual([
    ["G2", "T2", 20],
    ["G2b", "T2", 20],
    ["G1", "T1", 30],
    ["G4", "T4", 40],
  ]);
  const first = unwrap(await listCiGates(db, { limit: 1, after: null }));
  const next = unwrap(
    await listCiGates(db, { limit: 5, after: first[0] ?? null }),
  );
  expect(next.map((g) => g.id)).toEqual(["G2b", "G1", "G4"]);
  expect((await listCiGates(db, { limit: 0, after: null })).ok).toBe(false);
});

test("a gate's plan carries its project's required checks and wait; a bad list requires none extra", async () => {
  const db = await fresh('["build","test"]');
  expect(unwrap(await ciGatePlan(db, "G1"))).toMatchObject({
    gate: { id: "G1", state: "running" },
    ticket_status: "qa_harness",
    required: ["build", "test"],
    timeout_ms: 1_800_000,
    repo_ids: ["r1"],
    // No worktree branch for T1 here: nothing it delivers to read.
    repos: [],
  });
  for (const stored of ["not json", '[""]', '"build"']) {
    const other = await fresh(stored);
    expect(unwrap(await ciGatePlan(other, "G1")).required).toEqual([]);
  }
  const missing = await ciGatePlan(db, "nope");
  expect(missing.ok ? null : missing.error.class).toBe("not_found");
});

test("progress is written when it changes, and only then", async () => {
  const db = await fresh();
  const read = { repo_id: "r1", sha: HEAD, done: 1, total: 3 };
  const record = (o: Partial<typeof read> = {}, gate_id = "G1") =>
    recordCiProgress(db, {
      gate_id,
      ticket_id: "T1",
      reads: [{ ...read, ...o }],
    });
  expect(unwrap(await record())).toBe(1);
  expect(unwrap(await record())).toBe(0);
  expect(unwrap(await record({ done: 2 }))).toBe(1);
  expect(unwrap(await record({ done: 2 }, "G1-next"))).toBe(1);
  expect(unwrap(await dumpAllRows(db)).deliveries).toMatchObject([
    { ci_gate_id: "G1-next", ci_sha: HEAD, ci_done: 2, ci_total: 3 },
  ]);
  // A repo with no delivery row changes nothing; a read that is not one is refused.
  expect(unwrap(await record({ repo_id: "r9" }))).toBe(0);
  expect((await record({ sha: "HEAD" })).ok).toBe(false);
});
