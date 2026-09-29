// The boot self-check of each local executor's orphan scan: a
// tagged `sleep` under a session id that has no row, then the scan must find it. A host whose ps
// hides environments (a hardened binary, a sandbox) reports `orphan_scan: unavailable` in its
// executor's health_detail and a warning; its adopts still kill the recorded ref first, as before.
import { newId } from "@bayon/core";
import {
  HOME_TAG_ENV,
  SESSION_ID_ENV,
  type Executor,
  type Proc,
} from "@bayon/executors";
import type { Ctx } from "./context.js";

export async function checkOrphanScans(ctx: Ctx): Promise<void> {
  for (const { executor } of ctx.executors.values()) {
    if (executor.kind !== "local" || executor.listOwned === undefined) continue;
    const scan = await selfCheck(ctx, executor);
    ctx.orphanScan.set(executor.id, scan);
    if (scan === "unavailable") {
      ctx.log.warn(
        { executor: executor.id },
        "the orphan scan cannot see a tagged process on this executor: orphan_scan unavailable",
      );
    }
  }
}

async function selfCheck(
  ctx: Ctx,
  executor: Executor,
): Promise<"ok" | "unavailable"> {
  const sessionId = `frm-selfcheck-${newId(ctx.clock.now())}`;
  let proc: Proc;
  try {
    // node, as runners are, not /bin/sleep: macOS hides a platform binary's environment from ps.
    proc = await executor.exec(
      [process.execPath, "-e", "setTimeout(() => {}, 30000)"],
      {
        cwd: ctx.frmHome,
        env: {
          PATH: ctx.path,
          [HOME_TAG_ENV]: ctx.homeTag,
          [SESSION_ID_ENV]: sessionId,
        },
        stdin: "ignore",
      },
    );
  } catch (e) {
    ctx.log.error(
      { executor: executor.id, err: String(e) },
      "cannot start the orphan-scan check",
    );
    return "unavailable";
  }
  try {
    const owned = (await executor.listOwned?.()) ?? [];
    return owned.some((o) => o.sessionId === sessionId) ? "ok" : "unavailable";
  } catch (e) {
    ctx.log.error(
      { executor: executor.id, err: String(e) },
      "the orphan-scan check failed",
    );
    return "unavailable";
  } finally {
    proc.kill("SIGKILL");
  }
}
