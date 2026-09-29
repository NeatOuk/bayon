// A session's MCP side: its token, its tool set and toolset_hash, and
// whether the API answers. Runner-neutral: each adapter mounts spec.mcp its own way (Invariant 1).
import { randomBytes } from "node:crypto";
import {
  PULSE_ROLE,
  hashToolset,
  ok,
  sha256Hex,
  type Result,
} from "@bayon/core";
import { toolDefinitions, toolsetFor } from "@bayon/proto";
import type { RunnerAdapter, SpawnSpec } from "@bayon/runners";
import type { SessionConfig } from "./profile.js";

export const DEFAULT_MCP_URL = "http://127.0.0.1:3010/mcp";
const REACH_TIMEOUT_MS = 2_000;

export interface McpToken {
  /** Plaintext: in memory only, handed to the runner through spec.mcp. */
  readonly token: string;
  /** What the session row stores and the API looks up. */
  readonly hash: string;
}

/** A per-process token: 32 random bytes, base64url. Every spawn and every adopt mints one. */
export async function mintToken(): Promise<McpToken> {
  const token = randomBytes(32).toString("base64url");
  return { token, hash: await sha256Hex(token) };
}

export interface SessionToolset {
  /** The wire names the runner mounts, in catalogue order. */
  readonly tools: readonly string[];
  /** toolset_hash: exactly what the API's tools/list serves this session. */
  readonly hash: string;
}

/**
 * The tools a session's runner mounts: its role's §11.1 row ∩ the profile's allowlist, and none
 * without an MCP client. An allowlist entry that names no tool is a validation error.
 */
export async function sessionToolset(
  role: string,
  config: SessionConfig,
  adapter: RunnerAdapter,
): Promise<Result<SessionToolset>> {
  const tools = toolsetFor(role, config.toolAllowlist);
  if (!tools.ok) return tools;
  const mounted = adapter.caps().mcpClient ? tools.value : [];
  return ok({
    tools: mounted.map((t) => t.wire),
    hash: await hashToolset(toolDefinitions(mounted)),
  });
}

/** spec.mcp for a mounted tool set; nothing for an empty one. */
export const mcpMount = (
  url: string,
  token: McpToken,
  toolset: SessionToolset,
): Pick<SpawnSpec, "mcp"> =>
  toolset.tools.length === 0
    ? {}
    : { mcp: { url, token: token.token, tools: toolset.tools } };

/**
 * Plan rule 4: a pulse session carries MCP tools only, so its runner withholds its own. Runner-
 * neutral: each adapter maps `builtinTools` its own way (Invariant 1).
 */
export const builtinToolsFor = (
  role: string,
): Pick<SpawnSpec, "builtinTools"> =>
  role === PULSE_ROLE ? { builtinTools: "none" } : {};

/** The API's /api/v1/health beside its /mcp. The production check; tests inject their own. */
export async function httpReachable(mcpUrl: string): Promise<boolean> {
  try {
    const res = await fetch(new URL("/api/v1/health", mcpUrl), {
      signal: AbortSignal.timeout(REACH_TIMEOUT_MS),
    });
    return res.ok;
  } catch {
    return false; // refused, reset or timed out: each means the tools would be dead
  }
}
