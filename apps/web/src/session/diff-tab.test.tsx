import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { DiffTab } from "@/session/diff-tab";
import { PATCH, repoDiff, sessionDiff } from "@/test/diff-fixtures";
import {
  apiError,
  callsTo,
  renderWithProviders,
  stubFetch,
} from "@/test/render";

const DIFF = "/api/v1/sessions/S1/diff";

test("a worktree diff shows each repo's branch, range, files, untracked files and the patch by line", async () => {
  stubFetch({ [DIFF]: sessionDiff({ session_id: "S1" }) });
  renderWithProviders(<DiffTab sessionId="S1" />);
  expect(screen.getByRole("status").textContent).toBe("Reading the diff…");

  const repo = await screen.findByRole("region", { name: "repo-1 · wt-1" });
  expect(
    screen.getByText(
      "The session's worktrees on the API's host, against their base. Read 2027-01-15 08:00 UTC.",
    ),
  ).toBeTruthy();
  expect(within(repo).getByText("agent/FRM-812")).toBeTruthy();
  expect(within(repo).getByText("aaaaaaa..bbbbbbb")).toBeTruthy();
  expect(within(repo).getByText("Files · 2")).toBeTruthy();
  const files = within(repo).getByRole("table", { name: "changed files" });
  const rows = within(files).getAllByRole("row");
  expect(rows.map((row) => row.textContent)).toEqual([
    "pathaddeddeleted",
    "src/a.ts+1−1",
    "logo.pngbinarybinary",
  ]);
  expect(
    within(
      within(repo).getByRole("list", { name: "untracked files" }),
    ).getByText("notes.txt"),
  ).toBeTruthy();
  const patch = within(repo).getByLabelText("patch");
  expect(patch.textContent).toBe(PATCH.slice(0, -1).replaceAll("\n", ""));
  expect(within(patch).getByText("+new").getAttribute("data-tone")).toBe("add");
  expect(within(patch).getByText("-old").getAttribute("data-tone")).toBe("del");
  expect(
    within(patch).getByText("@@ -1,2 +1,2 @@").getAttribute("data-tone"),
  ).toBe("hunk");
  expect(screen.queryByText("Patch capped")).toBeNull();
});

test("a capped patch says how much is shown and where the full patch is", async () => {
  stubFetch({
    [DIFF]: sessionDiff({
      session_id: "S1",
      repos: [
        repoDiff({
          files_total: 250,
          untracked: [],
          untracked_total: 0,
          patch: {
            text: PATCH,
            truncated: true,
            bytes: 90_000,
            lines: 2_400,
            full_path: "/frm/runtime/sessions/S1/diffs/wt-1-0123.patch",
          },
        }),
        repoDiff({
          worktree_id: "wt-2",
          patch: {
            text: PATCH,
            truncated: true,
            bytes: 90_000,
            lines: 2_400,
            full_path: null,
          },
        }),
      ],
    }),
  });
  renderWithProviders(<DiffTab sessionId="S1" />);
  const repo = await screen.findByRole("region", { name: "repo-1 · wt-1" });
  expect(within(repo).getByText("Files · 250 (first 2 shown)")).toBeTruthy();
  expect(
    within(repo).getByText(
      "Showing the first 8 of 2400 lines (90000 bytes in all). The full patch is at /frm/runtime/sessions/S1/diffs/wt-1-0123.patch",
    ),
  ).toBeTruthy();
  expect(
    within(screen.getByRole("region", { name: "repo-1 · wt-2" })).getByText(
      /The full patch could not be kept on the API's host\./,
    ),
  ).toBeTruthy();
});

test("a session elsewhere shows its gate's diff.patch; a repo that cannot be read says why", async () => {
  stubFetch({
    [DIFF]: sessionDiff({
      session_id: "S1",
      source: "gate",
      repos: [
        repoDiff({
          worktree_id: null,
          branch: null,
          untracked: [],
          untracked_total: 0,
          gate: { id: "g1", kind: "code_review", attempt: 2, state: "passed" },
        }),
        repoDiff({
          repo_id: "repo-2",
          worktree_id: null,
          gate: { id: "g2", kind: "code_review", attempt: 1, state: "running" },
          files: [],
          files_total: 0,
          untracked: [],
          untracked_total: 0,
          patch: null,
          unavailable: "gate g2 has no diff.patch yet",
        }),
      ],
    }),
  });
  renderWithProviders(<DiffTab sessionId="S1" />);
  const first = await screen.findByRole("region", {
    name: "repo-1 · code_review #2",
  });
  expect(within(first).getByText("Passed").dataset.tone).toBe("success");
  expect(
    screen.getByText(/this is what its gates pinned \(diff\.patch\)/),
  ).toBeTruthy();
  const second = screen.getByRole("region", {
    name: "repo-2 · code_review #1",
  });
  expect(
    within(second).getByText("No diff: gate g2 has no diff.patch yet"),
  ).toBeTruthy();
  expect(within(second).queryByLabelText("patch")).toBeNull();
});

test("nothing to show says why; a failed read says so; Refresh reads it again", async () => {
  let failing = false;
  const fetchMock = stubFetch({
    [DIFF]: () =>
      failing
        ? apiError(404, "not_found", "session S1 does not exist")
        : sessionDiff({
            session_id: "S1",
            source: "none",
            repos: [],
            reason: "session S1 holds no worktree",
          }),
  });
  const user = userEvent.setup();
  renderWithProviders(<DiffTab sessionId="S1" />);
  expect(await screen.findByText("No diff")).toBeTruthy();
  expect(screen.getByText("session S1 holds no worktree")).toBeTruthy();
  failing = true;
  await user.click(screen.getByRole("button", { name: "Refresh" }));
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("The diff is unavailable")).toBeTruthy();
  expect(within(alert).getByText("session S1 does not exist")).toBeTruthy();
  await waitFor(() => expect(callsTo(fetchMock, DIFF)).toHaveLength(2));
  // The alert's own Retry reads it again too.
  await user.click(within(alert).getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(callsTo(fetchMock, DIFF)).toHaveLength(3));
});
