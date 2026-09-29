import { expect, test } from "vitest";
import { CATALOGUE_TOOLS } from "./mcp-tools.js";
import {
  DEFAULT_ALLOWLIST,
  withProfileDefaults,
  type Row,
} from "./profile-defaults.js";

const BASE: Row = {
  id: "build",
  name: "build",
  runner_id: "fixture",
  model_tier: "standard",
};

test("a row naming no tools gets the whole catalogue as its allowlist", async () => {
  const filled = await withProfileDefaults(BASE, 1_000);
  expect(filled["tool_allowlist_json"]).toBe(DEFAULT_ALLOWLIST);
  expect(JSON.parse(String(filled["tool_allowlist_json"]))).toEqual(
    CATALOGUE_TOOLS,
  );
  expect(filled["version"]).toBe(1);
  expect(filled["created_at"]).toBe(1_000);
  expect(typeof filled["hash"]).toBe("string");
});

test("an allowlist the row gives is kept as given, [] included", async () => {
  const narrow = await withProfileDefaults(
    { ...BASE, tool_allowlist_json: ["ticket_get"] },
    1_000,
  );
  expect(narrow["tool_allowlist_json"]).toEqual(["ticket_get"]);

  const none = await withProfileDefaults(
    { ...BASE, tool_allowlist_json: [] },
    1_000,
  );
  expect(none["tool_allowlist_json"]).toEqual([]);
});

test("the hash covers the filled-in allowlist: naming every tool hashes the same as naming none", async () => {
  const implicit = await withProfileDefaults(BASE, 1_000);
  // A caller normalizes a *_json column to its canonical string form before this runs (as
  // config-apply.ts's jsonColumns does), so the same allowlist given explicitly hashes identically.
  const explicit = await withProfileDefaults(
    { ...BASE, tool_allowlist_json: DEFAULT_ALLOWLIST },
    1_000,
  );
  expect(explicit["hash"]).toBe(implicit["hash"]);
});

test("id, name, version, hash and created_at never enter the hash", async () => {
  const a = await withProfileDefaults({ ...BASE, id: "a", name: "a" }, 1_000);
  const b = await withProfileDefaults({ ...BASE, id: "b", name: "b" }, 2_000);
  expect(a["hash"]).toBe(b["hash"]);
});
