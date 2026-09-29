// The MCP server's tunables (config over code): `settings` rows mcp.*, each absent one at its
// default. Caps are §8.5's backstop; the rate is per session, on the injected clock.
import { err, ok, type Result } from "@bayon/core";
import { MCP_RESULT_CAP } from "@bayon/proto";
import { z } from "zod";

export interface McpLimits {
  readonly capBytes: number;
  readonly capLines: number;
  readonly rateCalls: number;
  readonly rateWindowMs: number;
  /** The largest request body /mcp accepts (design §2). */
  readonly bodyBytes: number;
}

/** The API's JSON parser stops at 100 KB; /mcp's own limit sits below it. */
const MAX_BODY_BYTES = 100 * 1024;

export const DEFAULT_MCP_LIMITS: McpLimits = {
  capBytes: MCP_RESULT_CAP.bytes,
  capLines: MCP_RESULT_CAP.lines,
  rateCalls: 20,
  rateWindowMs: 10_000,
  bodyBytes: 64 * 1024,
};

const count = z.int().positive();
const Settings = z.object({
  // The projection needs room for its marker line: smaller caps could not hold one.
  "mcp.cap_bytes": count.min(1024).optional(),
  "mcp.cap_lines": count.min(8).optional(),
  "mcp.rate_calls": count.optional(),
  "mcp.rate_window_ms": count.optional(),
  "mcp.body_bytes": count.min(1024).max(MAX_BODY_BYTES).optional(),
});

export const MCP_SETTING_KEYS: readonly string[] = Object.keys(Settings.shape);

/** The limits from `settings` rows (keys MCP_SETTING_KEYS), each absent one at its default. */
export function mcpLimits(
  rows: Readonly<Record<string, unknown>>,
): Result<McpLimits> {
  const parsed = Settings.safeParse(rows);
  if (!parsed.success) {
    return err({
      class: "validation",
      message: `mcp settings: ${z.prettifyError(parsed.error)}`,
      retryable: false,
    });
  }
  const s = parsed.data;
  return ok({
    capBytes: s["mcp.cap_bytes"] ?? DEFAULT_MCP_LIMITS.capBytes,
    capLines: s["mcp.cap_lines"] ?? DEFAULT_MCP_LIMITS.capLines,
    rateCalls: s["mcp.rate_calls"] ?? DEFAULT_MCP_LIMITS.rateCalls,
    rateWindowMs: s["mcp.rate_window_ms"] ?? DEFAULT_MCP_LIMITS.rateWindowMs,
    bodyBytes: s["mcp.body_bytes"] ?? DEFAULT_MCP_LIMITS.bodyBytes,
  });
}
