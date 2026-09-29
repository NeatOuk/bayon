import { describe, expect, test } from "vitest";
import { DEFAULT_COMPLEXITY_RUBRIC } from "../complexity/rubric.js";
import { isNonSource, ticketKey, TicketKeyPrefix } from "./key.js";
import {
  DEFAULT_TICKET_SETTINGS,
  TICKET_SETTINGS_KEYS,
  parseTicketSettings,
} from "./settings.js";

// Ticket settings: `settings` rows over zod defaults (config over code, no migration).

describe("parseTicketSettings", () => {
  test("no rows gives every default", () => {
    expect(parseTicketSettings(new Map())).toEqual({
      ok: true,
      value: DEFAULT_TICKET_SETTINGS,
    });
    expect(DEFAULT_TICKET_SETTINGS).toEqual({
      "tickets.key_prefix": "FRM-",
      "complexity.rubric": DEFAULT_COMPLEXITY_RUBRIC,
      "laws.plan_paths": { prefixes: ["docs/"], suffixes: [".md"] },
      "laws.git_timeout_ms": 5_000,
    });
    expect(TICKET_SETTINGS_KEYS.toSorted()).toEqual(
      Object.keys(DEFAULT_TICKET_SETTINGS).toSorted(),
    );
  });

  test("a row overrides its default", () => {
    const parsed = parseTicketSettings(
      new Map<string, unknown>([
        ["tickets.key_prefix", "BAY-"],
        ["laws.git_timeout_ms", 900],
      ]),
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: { "tickets.key_prefix": "BAY-", "laws.git_timeout_ms": 900 },
    });
  });

  test.each([
    ["tickets.key_prefix", "bay"],
    ["laws.git_timeout_ms", 0],
    [
      "complexity.rubric",
      { v: 1, factors: {}, tiers: { complex: 6, standard: 2 } },
    ],
    ["laws.plan_paths", { prefixes: [""] }],
  ])("an invalid %s row is a validation error", (key, value) => {
    const parsed = parseTicketSettings(new Map([[key, value]]));
    expect(parsed).toMatchObject({ ok: false, error: { class: "validation" } });
    expect(parsed.ok ? "" : parsed.error.message).toContain(key);
  });
});

describe("ticket keys (amendment 13, shared with the exporter)", () => {
  test("a key is the prefix and the number", () => {
    expect(ticketKey("FRM-", 42)).toBe("FRM-42");
  });

  test.each(["FRM-", "A-", "BAYON2-"])("%s is a prefix", (prefix) => {
    expect(TicketKeyPrefix.safeParse(prefix).success).toBe(true);
  });

  test.each(["frm-", "FRM", "-", "TOOLONGPREFIX-", "F R-"])(
    "%s is not",
    (prefix) => {
      expect(TicketKeyPrefix.safeParse(prefix).success).toBe(false);
    },
  );
});

describe("isNonSource", () => {
  const paths = { prefixes: ["docs/"], suffixes: [".md"] };
  test.each([
    ["docs/spikes/T1.md", true],
    ["docs/diagram.png", true],
    ["README.md", true],
    ["src/x.ts", false],
    ["documents/x.ts", false],
  ])("%s → %s", (path, expected) => {
    expect(isNonSource(path, paths)).toBe(expected);
  });
});
