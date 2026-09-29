import { expect, test } from "vitest";
import { firstLine, runNowText } from "@/pulses/pulse-model";
import { commandView } from "@/test/runner-fixtures";

// How a run-now's command reads as the supervisor moves it, and the one-line summary.

const run = (state: "pending" | "claimed" | "done" | "failed", o = {}) =>
  commandView({ id: "C-1", type: "pulse.run", state, ...o });

test("a run-now reads queued, then starting, then its outcome", () => {
  expect(runNowText(undefined)).toBe("queued");
  expect(runNowText(run("pending"))).toBe("queued");
  expect(runNowText(run("claimed"))).toBe("starting…");
  const done = (outcome: string) =>
    runNowText(run("done", { result: { pulse_id: "P-1", outcome } }));
  expect(done("running")).toBe("a pulse is running");
  expect(done("coalesced")).toBe("a pulse was already running: this joined it");
  expect(done("capped")).toBe("capped: this hour's most pulses have run");
  expect(done("skipped")).toBe("skipped: see its pulse");
  expect(done("denied")).toBe("denied by the pulse gate");
  // A new outcome is shown as given; a result of another shape is only "done".
  expect(done("deferred")).toBe("done: deferred");
  expect(runNowText(run("done", { result: null }))).toBe("done");
});

test("a failed run-now says why in the server's words, or that it gave none", () => {
  expect(
    runNowText(
      run("failed", {
        error: {
          class: "admission_refused",
          message: "refused (project_paused): project ws-shop is paused",
          retryable: true,
        },
      }),
    ),
  ).toBe("Not run: refused (project_paused): project ws-shop is paused");
  expect(runNowText(run("failed"))).toBe(
    "Not run: the supervisor gave no reason",
  );
});

test("a summary's first line drops emphasis and code marks; none is a dash", () => {
  expect(firstLine("**Staffed** `FRM-8`.\nThen waited.")).toBe(
    "Staffed FRM-8.",
  );
  expect(firstLine(null)).toBe("—");
});
