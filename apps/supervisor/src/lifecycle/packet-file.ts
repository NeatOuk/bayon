// Writes `.foreman/handoff-<n>.md` into the worktree through the executor (design,
// review MEDIUM 7), so a remote worktree works: argv only, no shell, a temp file renamed over.
import { dirname, join } from "node:path";
import { ok, type Result } from "@bayon/core";
import type { Argv, Executor } from "@bayon/executors";
import { exitedOk, runArgv, type ExecCtx } from "./exec.js";

export async function writePacketFile(
  ctx: ExecCtx,
  executor: Executor,
  dir: string,
  rel: string,
  text: string,
): Promise<Result<void>> {
  const path = join(dir, rel);
  const tmp = `${path}.tmp`;
  const steps: readonly (readonly [Argv, string | undefined])[] = [
    [["mkdir", "-p", dirname(path)], undefined],
    [["tee", tmp], text],
    [["mv", "-f", tmp, path], undefined],
  ];
  for (const [argv, input] of steps) {
    const what = `${argv[0]} ${rel}`;
    const ran = exitedOk(
      await runArgv(ctx, executor, argv, {
        what,
        ...(input === undefined ? {} : { input }),
        // Where the executor places sessions (a container), the write runs in the worktree, there.
        ...(executor.placeSession === undefined ? {} : { cwd: dir }),
      }),
      what,
    );
    if (!ran.ok) return ran;
  }
  return ok(undefined);
}
