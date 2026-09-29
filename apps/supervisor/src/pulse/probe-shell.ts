// A shell probe's process (§10.2): argv through the executor, never a shell string, with the env the
// caller passes as its entire environment (§14). Output is bounded in memory, and aborting the
// signal kills the process.
import type { Argv, ExitStatus, Executor } from "@bayon/executors";

/** Stdout kept in memory at most; a probe that writes more is killed. */
export const STDOUT_MAX_BYTES = 4 * 1024 * 1024;
const STDERR_MAX_BYTES = 64 * 1024;

export interface ArgvRun {
  readonly stdout: string;
  readonly stderr: string;
  /** Null when the program never started; `spawnError` then says why. */
  readonly status: ExitStatus | null;
  readonly spawnError: string | null;
  /** Stdout passed STDOUT_MAX_BYTES, so the process was killed. */
  readonly overflow: boolean;
}

export interface ArgvSpec {
  readonly executor: Executor;
  readonly argv: Argv;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly signal: AbortSignal;
}

/** An FrmError's class and message, or whatever was thrown, as one line. */
export function describeThrown(thrown: unknown): string {
  if (typeof thrown === "object" && thrown !== null && "message" in thrown) {
    const cls = "class" in thrown ? `${String(thrown.class)}: ` : "";
    return `${cls}${String(thrown.message)}`;
  }
  return String(thrown);
}

/** Reads `stream` to its end, keeping at most `max` bytes; past that it calls `onOverflow` once
 * and drains the rest, since an unread pipe blocks the program. */
async function collect(
  stream: AsyncIterable<Uint8Array>,
  max: number,
  onOverflow: () => void,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  let bytes = 0;
  let over = false;
  for await (const chunk of stream) {
    if (over) continue;
    const room = max - bytes;
    if (chunk.byteLength > room) {
      over = true;
      text += decoder.decode(chunk.subarray(0, room), { stream: true });
      onOverflow();
      continue;
    }
    bytes += chunk.byteLength;
    text += decoder.decode(chunk, { stream: true });
  }
  return text + decoder.decode();
}

export async function runArgv(o: ArgvSpec): Promise<ArgvRun> {
  const none = { stdout: "", stderr: "", status: null, overflow: false };
  if (o.signal.aborted) return { ...none, spawnError: "aborted before start" };
  const kill = new AbortController();
  const onAbort = () => kill.abort();
  o.signal.addEventListener("abort", onAbort, { once: true });
  try {
    let proc;
    try {
      proc = await o.executor.exec(o.argv, {
        cwd: o.cwd,
        env: o.env,
        stdin: "ignore",
        signal: kill.signal,
      });
    } catch (thrown) {
      return { ...none, spawnError: describeThrown(thrown) };
    }
    let overflow = false;
    const [stdout, stderr, status] = await Promise.all([
      collect(proc.stdout, STDOUT_MAX_BYTES, () => {
        overflow = true;
        kill.abort();
      }),
      collect(proc.stderr, STDERR_MAX_BYTES, () => undefined),
      proc.exited,
    ]);
    return { stdout, stderr, status, spawnError: null, overflow };
  } finally {
    o.signal.removeEventListener("abort", onAbort);
  }
}
