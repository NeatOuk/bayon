// The structured-output instruction. ACP's session/prompt carries no schema,
// so a run with SendSpec.output sends this as a second text block after the compiled prompt: part
// of the runner's protocol, like codex-exec's --output-schema, not of the run's prompt (which the
// supervisor compiles, Invariant 8). It is versioned, and the version heads the text it sends, so
// a raw log shows which instruction a run was given.

export const OUTPUT_INSTRUCTION_VERSION = "opencode-output/1";

/** The instruction for one schema: canonical text, the schema as compact JSON. */
export const outputInstruction = (
  schema: Readonly<Record<string, unknown>>,
): string =>
  [
    `[${OUTPUT_INSTRUCTION_VERSION}]`,
    "When you are done, your final message must be one JSON value and nothing else: no prose, no",
    "code fence. It must be valid against this JSON Schema, which will be checked:",
    JSON.stringify(schema),
  ].join("\n");
