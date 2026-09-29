import { describe, expect, test } from "vitest";
import type { Result } from "../errors.js";
import { localTokens, preflight, promptBudget } from "./budget.js";
import { compile, type CompiledPrompt } from "./compile.js";
import { TEMPLATES } from "./templates.js";

function value<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

const small = value(compile(TEMPLATES.operator, { task: "x".repeat(400) }));

test("localTokens is ~4 characters a token, rounded up", () => {
  expect(localTokens("")).toBe(0);
  expect(localTokens("abcd")).toBe(1);
  expect(localTokens("abcde")).toBe(2);
});

test("promptBudget is the cap less the margin", () => {
  expect(promptBudget(25_000, 15)).toBe(21_739);
  expect(promptBudget(115, 15)).toBe(100);
  expect(promptBudget(100, 0)).toBe(100);
  expect(promptBudget(0, 15)).toBe(0);
});

describe("preflight", () => {
  const input = (compiled: CompiledPrompt, capTokens: number) => ({
    compiled,
    runClass: "build",
    capTokens,
    marginPct: 15,
  });
  const tokens = localTokens(small.text);
  const padded = Math.ceil((tokens * 115) / 100);

  test("a prompt within its cap passes with the local count, margin excluded", async () => {
    expect(await preflight(input(small, 25_000))).toEqual({
      ok: true,
      value: { tokens, counter: "local" },
    });
  });

  test("the margin is added before comparing: exactly at the cap passes, one under refuses", async () => {
    expect((await preflight(input(small, padded))).ok).toBe(true);
    expect(await preflight(input(small, padded - 1))).toMatchObject({
      ok: false,
      error: { class: "over_budget" },
    });
  });

  test("a cap of 0 is n/a", async () => {
    expect((await preflight(input(small, 0))).ok).toBe(true);
  });

  test("a runner's count wins when given, rounded up", async () => {
    const r = await preflight({
      ...input(small, 25_000),
      estimate: async () => 10.2,
    });
    expect(r).toEqual({ ok: true, value: { tokens: 11, counter: "runner" } });
  });

  test("a runner count that fails or is no count falls back to the local one", async () => {
    const estimates = [
      () => Promise.reject(new Error("offline")),
      async () => -1,
      async () => Number.NaN,
    ];
    for (const estimate of estimates) {
      expect(await preflight({ ...input(small, 25_000), estimate })).toEqual({
        ok: true,
        value: { tokens, counter: "local" },
      });
    }
  });

  test("over budget: over_budget, with each section's size and what was cut", async () => {
    const big = value(
      compile(TEMPLATES.build, {
        mission: "Be good.",
        ticket: "t".repeat(30_000),
        current_step: "step 3",
      }),
    );
    const r = await preflight(input(big, 1_000));
    const count = localTokens(big.text);
    const over = Math.ceil((count * 115) / 100);
    const sizes = big.sections
      .map((s) =>
        s.name === "ticket"
          ? `ticket ${s.tokens} (cut from 7500)`
          : `${s.name} ${s.tokens}`,
      )
      .join(", ");
    expect(r).toEqual({
      ok: false,
      error: {
        class: "over_budget",
        message:
          `prompt build.v8 is over the build budget: ${over} tokens (${count} + 15 % margin) ` +
          `> cap 1000; sections, in local tokens: ${sizes}`,
        retryable: false,
        cause: {
          template_id: "build.v8",
          run_class: "build",
          cap_tokens: 1_000,
          tokens: count,
          margin_pct: 15,
          sections: big.sections,
          truncated: [
            { section: "ticket", tokens_before: 7_500, tokens_after: 6_000 },
          ],
        },
      },
    });
    expect(big.sections.map((s) => s.name)).toEqual([
      "template",
      "mission",
      "ticket",
      "current_step",
    ]);
  });
});
