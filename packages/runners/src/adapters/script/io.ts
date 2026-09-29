// The tiny IPC contract every `script` runner child speaks (mirrors fixture/program.ts, without its
// scripted-run DSL): wait for one `{"op":"send",...}` line before doing anything, honor
// `{"op":"interrupt"}`, write canonical-event JSON lines to stdout, and exit only when stdin ends --
// never call `process.exit()`. Job scripts (e.g. apps/supervisor/src/jobs/export-markdown.ts) import
// this to speak the protocol without re-implementing it.
import { z } from "zod";

export const ScriptOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("send"), runId: z.string(), text: z.string() }),
  z.object({ op: z.literal("interrupt") }),
]);
export type ScriptOp = z.infer<typeof ScriptOp>;
export type ScriptGo = Extract<ScriptOp, { op: "send" }>;

export interface ScriptIo {
  readonly stdout: { write(chunk: string): void };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Every parsed op from `stdin`, in order. A line that fails to parse is skipped, never fatal. */
export async function* readOps(
  stdin: AsyncIterable<Uint8Array>,
): AsyncGenerator<ScriptOp> {
  const decoder = new TextDecoder();
  let pending = "";
  for await (const chunk of stdin) {
    const lines = (pending + decoder.decode(chunk, { stream: true })).split(
      "\n",
    );
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const op = ScriptOp.safeParse(safeJson(line));
      if (op.success) yield op.data;
    }
  }
}

/**
 * Waits for the first `send`, ignoring anything else (an `interrupt` before any run is open has
 * nothing to interrupt). Resolves to `undefined` if stdin ends first -- the caller's only job then
 * is to exit. Callers must keep pulling from `ops` afterward: that is how they see `interrupt` and,
 * eventually, EOF.
 */
export async function readGo(
  ops: AsyncGenerator<ScriptOp>,
): Promise<ScriptGo | undefined> {
  for (;;) {
    const next = await ops.next();
    if (next.done === true) return undefined;
    if (next.value.op === "send") return next.value;
  }
}

/** Writes one canonical-event JSON line. `ts` is stamped at ingest, exactly like every other runner's. */
export function emit(
  io: ScriptIo,
  event: Readonly<Record<string, unknown>>,
): void {
  io.stdout.write(`${JSON.stringify(event)}\n`);
}
