// The text of a call whose arguments fail the tool's schema: zod's issues with
// their field paths, plus the tool's length hint when a string argument was too long,
// so the model learns how to fit rather than only that it did not. Capped like every result (§8.5).
import type { McpTool } from "@bayon/proto";
import { z } from "zod";

/** The longest an invalid-arguments text runs to. */
export const INVALID_ARGS_CAP = 2_000;

const tooLongString = (issue: z.core.$ZodIssue): boolean =>
  issue.code === "too_big" && issue.origin === "string";

export function invalidArguments(tool: McpTool, error: z.ZodError): string {
  const text = `invalid arguments: ${z.prettifyError(error)}`;
  const hint =
    tool.lengthHint !== undefined && error.issues.some(tooLongString)
      ? tool.lengthHint
      : undefined;
  if (hint === undefined) return text.slice(0, INVALID_ARGS_CAP);
  // zod's text gives way, so a long error still ends on the hint.
  return `${text.slice(0, INVALID_ARGS_CAP - hint.length - 1)}\n${hint}`;
}
