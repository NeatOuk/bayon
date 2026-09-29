// Structured output (§5.1 outputSchema, SendSpec.output) for this runner. The SDK's `outputFormat`
// becomes the CLI's `--json-schema` argv, so the schema is fixed when the process starts: it comes
// from SpawnSpec.output, and a send may only ask for that same schema. The run's answer is the
// `structured_output` of its `result` line, written to SendSpec.output.path before the line is
// queued, as codex writes its `-o` file before its turn completes.
import {
  canonicalJson,
  err,
  ok,
  type JsonValue,
  type Result,
} from "@bayon/core";
import type { Options } from "@anthropic-ai/claude-agent-sdk";
import type { Executor } from "@bayon/executors";
import type { RawRecord, SendSpec, SpawnSpec } from "../../adapter.js";
import { frmError } from "../../errors.js";
import { writeHomeFile } from "./home-file.js";

type Schema = Readonly<Record<string, unknown>>;

/**
 * The SDK option for a spawn's schema; none without one. The CLI validates the schema with a
 * draft-07 validator that knows no other meta-schema, and exits at start on a `$schema` it cannot
 * resolve (2020-12, which `z.toJSONSchema` declares). The declaration goes; the keywords stay.
 */
export function outputFormatFor(
  output: SpawnSpec["output"],
): Pick<Options, "outputFormat"> {
  if (output === undefined) return {};
  const schema = Object.fromEntries(
    Object.entries(output.schema).filter(([key]) => key !== "$schema"),
  );
  return { outputFormat: { type: "json_schema", schema } };
}

/** Two schemas are the same when their canonical JSON is (key order never matters). */
const sameSchema = (a: Schema, b: Schema): boolean =>
  // A schema is JSON: it crosses to the CLI as JSON text.
  canonicalJson(a as JsonValue) === canonicalJson(b as JsonValue);

/**
 * Where a run's structured output goes: undefined when the send asks for none; a validation error
 * when it asks for a schema the process was not started with, which this runner cannot honour.
 */
export function outputTarget(
  started: SpawnSpec["output"],
  requested: SendSpec["output"],
): Result<string | undefined> {
  if (requested === undefined) return ok(undefined);
  if (started === undefined) {
    return err(
      frmError(
        "validation",
        "structured output is fixed when this runner starts: the session was spawned without a schema (SpawnSpec.output)",
      ),
    );
  }
  return sameSchema(started.schema, requested.schema)
    ? ok(requested.path)
    : err(
        frmError(
          "validation",
          "structured output is fixed when this runner starts: the send's schema is not the one the session was spawned with",
        ),
      );
}

/** The open run's output path, armed by its send and taken by its result. */
export class OutputSlot {
  #path: string | undefined;

  arm(path: string | undefined): void {
    this.#path = path;
  }

  take(): string | undefined {
    const path = this.#path;
    this.#path = undefined;
    return path;
  }
}

const decoder = new TextDecoder();

/** A `result` line's frame, whose `structured_output` is the run's answer; undefined otherwise. */
export function resultFrameOf(
  record: RawRecord,
): { readonly structured_output?: unknown } | undefined {
  if (record.partial) return undefined;
  const text = decoder.decode(record.bytes);
  if (!text.includes('"result"')) return undefined;
  try {
    const frame: unknown = JSON.parse(text);
    return typeof frame === "object" &&
      frame !== null &&
      (frame as { type?: unknown }).type === "result"
      ? (frame as { structured_output?: unknown })
      : undefined;
  } catch {
    return undefined; // not JSON: the mapper stores it as unparsed
  }
}

/** The file's content: the answer as JSON text, as codex's `-o` holds its final message. */
export const outputText = (structuredOutput: unknown): string =>
  JSON.stringify(structuredOutput);

/** The warning's name, so a listener (and a test) can tell it from any other. */
export const OUTPUT_WARNING = "FrmStructuredOutput";

/**
 * Writes the answer to `path`, where `ex` keeps the session. Never rejects: a write that fails is
 * warned on this process, with the path and why. It leaves no file, or one cut short that does
 * not parse, and whoever reads `path` reports that (a gate: `reviewer_error`, never a pass).
 */
export async function deliverOutput(
  ex: Executor,
  path: string,
  structuredOutput: unknown,
): Promise<void> {
  try {
    const written = await writeHomeFile(ex, path, outputText(structuredOutput));
    if (written.ok) return;
    const cause =
      typeof written.error.cause === "string" ? `: ${written.error.cause}` : "";
    process.emitWarning(
      `structured output not delivered: ${written.error.message}${cause}`,
      OUTPUT_WARNING,
    );
  } catch (e) {
    process.emitWarning(
      `structured output not delivered: cannot write ${path}: ${String(e)}`,
      OUTPUT_WARNING,
    );
  }
}
