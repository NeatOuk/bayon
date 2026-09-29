// How this runner names the session's MCP tools: `mcp__<server>__<tool>`.
// The adapter mounts them under these names; the mapper reads them back out of `system/init`.

/** The session's MCP server, as the runner lists it. */
export const MCP_SERVER = "foreman";
const PREFIX = `mcp__${MCP_SERVER}__`;

/** The runner's name for the session's MCP tool `tool` (a wire name). */
export const mcpToolName = (tool: string): string => `${PREFIX}${tool}`;

/**
 * session_init's runner-neutral view of the exposed tools: the session's MCP tools by
 * wire name, and every other tool (the runner's own, or another server's) by the runner's name.
 */
export function splitTools(tools: readonly string[]): {
  readonly mcp_tools: string[];
  readonly builtin_tools: string[];
} {
  return {
    mcp_tools: tools
      .filter((t) => t.startsWith(PREFIX))
      .map((t) => t.slice(PREFIX.length)),
    builtin_tools: tools.filter((t) => !t.startsWith(PREFIX)),
  };
}

/**
 * The tool the CLI adds when it is started with a JSON schema (SDK `outputFormat`): the model
 * ends a turn by calling it, and its input is the result's `structured_output`. `system/init`
 * lists it only in such a process, which is how the mapper knows a run owes that output.
 */
export const STRUCTURED_OUTPUT_TOOL = "StructuredOutput";

/**
 * The tools whose large results the context proxy may compress (spec M12, §8.5): the shell, the
 * search tools, and reads of a background shell's output. In 2.1.269 that read was `TaskOutput`
 * (`BashOutput` its old alias); 2.1.283 has no such tool and the model reads the task's output file
 * with `Read`, so both names only match a transcript begun on an earlier CLI. File reads (`Read`)
 * are never compressed, nor any MCP tool.
 */
export const COMPRESSIBLE_TOOLS: ReadonlySet<string> = new Set([
  "Bash",
  "TaskOutput",
  "BashOutput",
  "Grep",
  "Glob",
]);
