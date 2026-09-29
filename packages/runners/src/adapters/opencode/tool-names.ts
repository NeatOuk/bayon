// How opencode names things this adapter maps (opencode 1.18.32 mcp/catalog.ts, tool/shell/id.ts).

/** The session's MCP server, as the config names it. */
export const MCP_SERVER = "foreman";
/** The env var the turn host reads the bearer from; opencode's env never carries it. */
export const MCP_TOKEN_ENV = "FRM_MCP_TOKEN";

/** opencode's shell tool id and permission key (kept "bash" whatever the shell). */
export const SHELL_TOOL = "bash";
export const TODO_TOOL = "todowrite";
export const FILE_TOOLS = {
  write: "write",
  edit: "edit",
  patch: "apply_patch",
} as const;

const sanitize = (value: string): string =>
  value.replace(/[^a-zA-Z0-9_-]/g, "_");

/** An MCP tool as opencode exposes it to the model and to its permission rules. */
export const mcpToolName = (tool: string): string =>
  `${sanitize(MCP_SERVER)}_${sanitize(tool)}`;

const PREFIX = `${sanitize(MCP_SERVER)}_`;

/** The wire name of one of our MCP server's tools, or undefined for any other tool. */
export const mcpWireName = (opencodeName: string): string | undefined =>
  opencodeName.startsWith(PREFIX) && opencodeName.length > PREFIX.length
    ? opencodeName.slice(PREFIX.length)
    : undefined;

/**
 * The env var opencode reads the context proxy's bearer from, by an `{env:…}` reference in the
 * session config's provider headers (spec M12): the config text itself never holds it.
 */
export const CTX_TOKEN_ENV = "FRM_CTX_TOKEN";

/**
 * The tools whose large results the context proxy may compress (spec M12, §8.5), checked in the
 * pinned opencode (1.18.32, whose tools are bash, read, write, edit, apply_patch, glob, grep,
 * todowrite, webfetch, websearch, skill and question: it has no `list`). File reads never are.
 */
export const COMPRESSIBLE_TOOLS: ReadonlySet<string> = new Set([
  SHELL_TOOL,
  "grep",
  "glob",
]);
