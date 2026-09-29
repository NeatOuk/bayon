import { canonicalJson, hashConfig, type JsonValue } from "@bayon/core";
import { z } from "zod";
import { CATALOGUE_TOOLS } from "./mcp-tools.js";

// A profile row's defaults (moved from `tools/frm/src/config-apply.ts`): `frm config
// apply`, `frm project add` and `POST /projects` all fill a profile the same way, so none of the
// three can drift on what "the default allowlist" or a profile's hash means.

export const Row = z.record(z.string(), z.json());
export type Row = z.infer<typeof Row>;

/** Not part of a profile's content hash (the smokes hash the same fields). */
const PROFILE_META = new Set(["id", "name", "version", "hash", "created_at"]);

/**
 * A profile that names no tools gets every one: its session's role row then decides.
 * The column's own default, [], mounts no MCP server at all, and the agent could not write back.
 */
export const DEFAULT_ALLOWLIST = canonicalJson([...CATALOGUE_TOOLS]);

/** Fills in a profile row's version, hash and created_at, and its allowlist when the row names none
 * (`frm project add` and `POST /projects` reuse this so all three writers never drift on what "the
 * full allowlist" means). */
export async function withProfileDefaults(row: Row, now: number): Promise<Row> {
  const filled: Row =
    "tool_allowlist_json" in row
      ? row
      : { ...row, tool_allowlist_json: DEFAULT_ALLOWLIST };
  // The hash covers the allowlist filled in, as it covers one the file gave.
  const content = Object.fromEntries(
    Object.entries(filled).filter(([k]) => !PROFILE_META.has(k)),
  );
  return {
    version: 1,
    hash: await hashConfig(content as JsonValue),
    created_at: now,
    ...filled,
  };
}
