import { describe, expect, test } from "vitest";
import { OPERATOR, ORCH, WORKER } from "./fixtures.js";
import { decidePatch } from "./patch.js";
import { LawRefusalCause, lawRefused } from "./refusal.js";

// PATCH laws: a worker edits only its own ticket, may raise needs_human but never clear it, and
// never reprioritizes or reassigns.

describe("decidePatch", () => {
  test("the operator and the orchestrator may patch anything", () => {
    for (const actor of [OPERATOR, ORCH]) {
      expect(
        decidePatch({
          actor,
          own: false,
          fields: ["priority", "owner_session_id"],
          needsHuman: false,
        }),
      ).toEqual({ allowed: true, rule: "patch" });
    }
  });

  test("a worker may patch its own ticket and raise needs_human", () => {
    expect(
      decidePatch({
        actor: WORKER,
        own: true,
        fields: ["body_md", "needs_human"],
        needsHuman: true,
      }),
    ).toEqual({
      allowed: true,
      rule: "patch",
    });
  });

  test.each([
    [
      "another ticket",
      { own: false, fields: ["body_md"] },
      "cross_ticket_write",
    ],
    ["priority", { own: true, fields: ["priority"] }, "actor_not_allowed"],
    [
      "owner_session_id",
      { own: true, fields: ["owner_session_id"] },
      "actor_not_allowed",
    ],
    [
      "clearing needs_human",
      { own: true, fields: ["needs_human"], needsHuman: false },
      "actor_not_allowed",
    ],
  ] as const)("a worker may not change %s", (_name, patch, reason) => {
    expect(decidePatch({ actor: WORKER, ...patch })).toMatchObject({
      allowed: false,
      rule: "patch",
      reason,
    });
  });
});

describe("lawRefused", () => {
  test("is a law_refused FrmError whose cause the API can parse", () => {
    const error = lawRefused({
      allowed: false,
      rule: "start_spike",
      reason: "no_session",
      detail: "no live session holds ticket T1",
    });
    expect(error).toEqual({
      class: "law_refused",
      message: "start_spike: no live session holds ticket T1",
      retryable: false,
      cause: {
        rule: "start_spike",
        reason: "no_session",
        detail: "no live session holds ticket T1",
      },
    });
    expect(LawRefusalCause.parse(error.cause)).toEqual(error.cause);
  });
});
