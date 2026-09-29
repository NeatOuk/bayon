// How this runner mounts the session's MCP server: after the initialize handshake, with
// the SDK's setMcpServers, one control request on the CLI's stdin. So the bearer never reaches argv
// (where the SDK serializes mcpServers, an earlier change F1), the CLI's env (which its Bash tool inherits)
// or a file in the session home (which its Bash tool can read): the CLI holds it in memory, for its
// MCP client alone.
import type {
  McpHttpServerConfig,
  McpSetServersResult,
} from "@anthropic-ai/claude-agent-sdk";
import type { FrmError } from "@bayon/core";
import type { SpawnSpec } from "../../adapter.js";
import { frmError } from "../../errors.js";
import { MCP_SERVER } from "./tool-names.js";

type McpMount = NonNullable<SpawnSpec["mcp"]>;

/** The one Query method a mount needs. */
export type McpMounter = {
  setMcpServers(
    servers: Record<string, McpHttpServerConfig>,
  ): Promise<McpSetServersResult>;
};

/** The session's server as the CLI's MCP client connects to it: the literal bearer in its header. */
export const mcpServer = (mount: McpMount): McpHttpServerConfig => ({
  type: "http",
  url: mount.url,
  headers: { Authorization: `Bearer ${mount.token}` },
  alwaysLoad: true, // listed up front, never behind tool search
});

/** `text` with every occurrence of `token` gone: an SDK or CLI message may quote the header. */
const redact = (text: string, token: string): string =>
  text.replaceAll(token, "[redacted]");

/**
 * Mounts `spec.mcp` on a started CLI (nothing without one); the error that fails the start when the
 * CLI refuses the request or cannot connect the server. /mcp is Bayon's own API, so a session that
 * cannot reach it is a fault, not a session without tools; the connect is worth a retry.
 */
export async function mountMcp(
  q: McpMounter,
  spec: SpawnSpec,
): Promise<FrmError | undefined> {
  if (spec.mcp === undefined) return undefined;
  const token = spec.mcp.token;
  let result: McpSetServersResult;
  try {
    result = await q.setMcpServers({ [MCP_SERVER]: mcpServer(spec.mcp) });
  } catch (e) {
    const why = redact(e instanceof Error ? e.message : String(e), token);
    return frmError("spawn_failed", `the runner refused the MCP mount: ${why}`);
  }
  const failed = result.errors[MCP_SERVER];
  return failed === undefined
    ? undefined
    : frmError(
        "spawn_failed",
        `the runner could not connect the MCP server: ${redact(failed, token)}`,
        { retryable: true },
      );
}
