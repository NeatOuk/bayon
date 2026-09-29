import { RunnerCaps } from "@bayon/core";
import { expect, test } from "vitest";
import { CLAUDE_IMAGE_CLI } from "./container.js";
import {
  CAPS,
  DEFAULTS,
  MODELS,
  detectVersion,
  registration,
} from "./registration.js";
import { DEFAULT_WINDOW, ONE_M_WINDOW, hasOneM } from "./window.js";

test("caps are declared honestly and parse as the §5.1 matrix", () => {
  expect(RunnerCaps.parse(CAPS)).toEqual(CAPS);
  const declared = Object.entries(CAPS).flatMap(([cap, yes]) =>
    yes ? [] : [cap],
  );
  // Unwired caps are not declared: conformance would contradict them. outputSchema is
  // wired through the SDK's outputFormat, and conformance test 13 drives it.
  expect(declared).toEqual([
    "tokenCounting",
    "toolApprovalCallback",
    "sandboxModes",
    "hooks",
  ]);
  expect(CAPS.outputSchema).toBe(true);
});

test("the version comes from the installed SDK and its bundled CLI", () => {
  expect(detectVersion()).toBe("0.3.284 (cli 2.1.284)");
});

test("registration names the runner and its models rows, one active per tier", () => {
  const reg = registration();
  expect(reg.runner).toEqual({
    id: "claude-sdk",
    kind: "llm_sdk",
    adapter: "claude-sdk",
    versionDetected: "0.3.284 (cli 2.1.284)",
    caps: CAPS,
    defaults: {
      ...DEFAULTS,
      // The CLI this SDK bundles, then its link and sha256 check (container.test.ts).
      containerInstall: [
        "npm install -g @anthropic-ai/claude-code@2.1.284",
        expect.stringContaining(CLAUDE_IMAGE_CLI),
      ],
      egressHosts: ["api.anthropic.com"],
    },
  });
  expect(reg.runner.defaults).not.toHaveProperty("containerUnready");
  expect(
    reg.models.map((m) => [m.id, m.tier, m.model, m.effort, m.standby]),
  ).toEqual([
    [
      "claude-sdk.complex-opus-5-5",
      "complex",
      "claude-opus-5-5[1m]",
      "xhigh",
      undefined,
    ],
    ["claude-sdk.complex", "complex", "claude-opus-5", "xhigh", true],
    ["claude-sdk.standard", "standard", "claude-sonnet-5", "high", undefined],
    ["claude-sdk.cheap", "cheap", "claude-haiku-4-5", undefined, undefined],
  ]);
  expect(reg.models).toBe(MODELS);
  const active = MODELS.filter((m) => m.standby !== true).map((m) => m.tier);
  expect(active.toSorted()).toEqual(["cheap", "complex", "standard"]);
});

// A certificate pins its model string and the kit hash covers it: these rows keep
// theirs, so their certificates hold across an earlier change/235. Only Opus 5.5 is a new string.
test("the certified rows keep their model strings; only the new complex row is new", () => {
  const strings = Object.fromEntries(MODELS.map((m) => [m.id, m.model]));
  expect(strings).toMatchObject({
    "claude-sdk.complex": "claude-opus-5",
    "claude-sdk.standard": "claude-sonnet-5",
    "claude-sdk.cheap": "claude-haiku-4-5",
  });
});

// the list prices, per MTok; cache writes are the 5-minute ones, 1.25× input.
test("prices are the published list prices", () => {
  expect(
    MODELS.map((m) => [
      m.model,
      m.priceInPerMtok,
      m.priceOutPerMtok,
      m.priceCacheReadPerMtok,
      m.priceCacheWritePerMtok,
    ]),
  ).toEqual([
    ["claude-opus-5-5[1m]", 4, 20, 0.2, 5],
    ["claude-opus-5", 5, 25, 0.5, 6.25],
    ["claude-sonnet-5", 2, 10, 0.2, 2.5],
    ["claude-haiku-4-5", 1, 5, 0.1, 1.25],
  ]);
  for (const m of MODELS) {
    expect(m.priceCacheWritePerMtok).toBeCloseTo(m.priceInPerMtok * 1.25);
  }
});

// the rows claimed 1M, the CLI behind the context proxy gave sonnet 200k, and the
// context ceiling (70 % of 1M) could never fire before the CLI refused the prompt itself.
test("a row records 1M only with the CLI's [1m] opt-in, else the CLI's 200k default", () => {
  for (const m of MODELS) {
    expect([m.model, m.contextTokens]).toEqual([
      m.model,
      hasOneM(m.model) ? ONE_M_WINDOW : DEFAULT_WINDOW,
    ]);
  }
  expect(
    MODELS.filter((m) => m.contextTokens === ONE_M_WINDOW).map((m) => m.id),
  ).toEqual(["claude-sdk.complex-opus-5-5"]);
});

test("defaults name the auth secret as one-of, API key first, and say how to get each", () => {
  expect(DEFAULTS).not.toHaveProperty("secretEnv");
  expect(DEFAULTS.secretEnvAnyOf).toEqual([
    ["ANTHROPIC_API_KEY"],
    ["CLAUDE_CODE_OAUTH_TOKEN"],
  ]);
  expect(Object.keys(DEFAULTS.secretHints).toSorted()).toEqual(
    DEFAULTS.secretEnvAnyOf.flat().toSorted(),
  );
  expect(DEFAULTS.secretHints.CLAUDE_CODE_OAUTH_TOKEN).toContain(
    "claude setup-token",
  );
});

// no settings file is loaded, so .claude/settings.json no longer shapes a session and is
// no longer hashed; both CLAUDE.md files are delivered in the system prompt, so both are.
test("defaults name the hash inputs, never their values", () => {
  expect(DEFAULTS).toMatchObject({
    hashInputs: ["CLAUDE.md", ".claude/CLAUDE.md"],
    settingSources: [],
    permissionMode: "acceptEdits",
    permissionPrompts: "none",
  });
});

// a builder started a background subagent, then ended its turn saying it would draft
// the plan "once it reports back". A run ends on its terminal event (Invariant 3) and nothing
// restarts a session on its own, so it never reported and the session idled with the ticket still
// staffed. Withheld by default rather than detected after the fact: a run that cannot background
// cannot end with work pending in the background.
test("the subagent tool is withheld by default, so no run can end waiting on one", () => {
  expect(DEFAULTS.disallowedTools).toContain("Task");
  // Caps still say the runner can do it: this is what we allow, not what it is able to do.
  expect(CAPS.subagents).toBe(true);
});
