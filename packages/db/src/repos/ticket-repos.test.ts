import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { OPERATOR, gateDb, seedRows, unwrap } from "../testing.js";
import { allow, planFor, rows } from "./fixtures.js";
import { transitionTicket } from "./ticket-transition.js";
import { getTicket } from "./tickets.js";

// the `ticket_repos` writer, inside the code_review transition's own transaction. Until
// it existed the table had no writer anywhere, `planRound` always read `[]`, and H3 refused every
// repo-less diff gate of a ticket whose worktrees spanned repos — so a multi-repo ticket could
// never leave `code_review`. Against a real temp SQLite file, as every db test is.

let t: Awaited<ReturnType<typeof gateDb>>;
beforeEach(async () => {
  t = await gateDb(["building", "code_review", "building"]);
  unwrap(
    await seedRows(t.db, {
      repos: [
        { id: "r1", name: "r1", mirror_path: "/m/r1" },
        { id: "r2", name: "r2", mirror_path: "/m/r2" },
      ],
    }),
  );
});
afterEach(() => t.cleanup());

const move = async (
  from: Parameters<typeof planFor>[0],
  to: Parameters<typeof planFor>[1],
  touchedRepos: readonly string[] = [],
) => {
  const ticket = unwrap(await getTicket(t.db, "ticket-1"));
  return transitionTicket(
    t.db,
    {
      id: ticket.id,
      version: ticket.version,
      to,
      by: OPERATOR,
      touchedRepos,
    },
    allow,
    undefined,
    planFor(from, to),
  );
};

const reposOf = (ticketId: string) =>
  (
    rows(
      t.db,
      "SELECT repo_id FROM ticket_repos WHERE ticket_id = ? ORDER BY repo_id",
      ticketId,
    ) as { repo_id: string }[]
  ).map((r) => r.repo_id);

const runningGates = () =>
  (
    rows(
      t.db,
      "SELECT kind, repo_id FROM gates WHERE ticket_id = 'ticket-1' AND state = 'running' ORDER BY kind, repo_id",
    ) as { kind: string; repo_id: string | null }[]
  ).map((g) => [g.kind, g.repo_id]);

describe("recordTicketReposIn, through the transition", () => {
  test("the repos land, and the round this move opens gets a gate for each", async () => {
    unwrap(await move("building", "code_review", ["r1", "r2"]));
    expect(reposOf("ticket-1")).toEqual(["r1", "r2"]);
    // The point of writing them *before* the gate effects: the round reads the rows this same
    // transaction wrote, so the gates are repo-scoped and H3 never refuses their pin.
    expect(runningGates()).toEqual([
      ["code_review", "r1"],
      ["code_review", "r2"],
    ]);
  });

  test("no repos: nothing is written, and the round opens the one repo-less gate", async () => {
    unwrap(await move("building", "code_review"));
    expect(reposOf("ticket-1")).toEqual([]);
    expect(runningGates()).toEqual([["code_review", null]]);
  });

  test("the table is the union across rounds: a second round adds without removing", async () => {
    unwrap(await move("building", "code_review", ["r1"]));
    unwrap(await move("code_review", "review_fix"));
    unwrap(await move("review_fix", "code_review", ["r2"]));
    expect(reposOf("ticket-1")).toEqual(["r1", "r2"]);
    // r1 was touched in round 1 and not in round 2; §3.1 still wants its evidence, so round 2
    // opens a gate for it too.
    expect(runningGates()).toEqual([
      ["code_review", "r1"],
      ["code_review", "r2"],
    ]);
  });

  test("a repo already recorded is not inserted twice", async () => {
    unwrap(await move("building", "code_review", ["r1", "r2"]));
    unwrap(await move("code_review", "review_fix"));
    unwrap(await move("review_fix", "code_review", ["r1", "r2"]));
    expect(reposOf("ticket-1")).toEqual(["r1", "r2"]);
  });

  test("an unknown repo id is refused, and the move rolls back with it", async () => {
    const moved = await move("building", "code_review", ["r1", "ghost"]);
    expect(moved).toMatchObject({
      ok: false,
      error: { class: "internal", message: expect.stringContaining("ghost") },
    });
    expect(reposOf("ticket-1")).toEqual([]);
    expect(unwrap(await getTicket(t.db, "ticket-1")).status).toBe("building");
  });
});
