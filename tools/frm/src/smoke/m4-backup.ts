// `--m4`'s backup phase (deferred): the epic's acceptance says an
// encrypted backup is written and its restore passes `integrity_check`. Until now `--m4` claimed
// that in `frm --help` and budgeted two steps for it without running either.
//
// The key is generated per run, into this smoke's own throwaway env, and reaches `frm backup` the
// way every other secret reaches a child: in the environment, resolved at the point of use (§14).
// Nothing is written to the operator's Keychain, nothing lands in a worktree, and the key dies with
// the process. `m4Config` already disables the nightly job for this — its catch-up would otherwise
// take a backup at boot using the operator's real key.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import { BACKUP_KEY_NAME, getLastBackup } from "@bayon/db";
import { runBackupCommand, type BackupIo } from "../backup.js";
import { verdict } from "./harness.js";
import type { World } from "./phases.js";

/** One refusal shape for this phase, so a step returning a value can still fail like the others. */
const refuse = <T>(message: string): Result<T> =>
  err({ class: "validation", message, retryable: false });

/** 32 random bytes as 64 hex characters: what `frm backup init-key` would have stored. */
const testKey = (): string => randomBytes(32).toString("hex");

/** Runs one backup command with the smoke's own env, collecting its output for the assertions. */
async function run(
  w: World,
  key: string,
  cmd: Parameters<typeof runBackupCommand>[0],
): Promise<Result<readonly string[]>> {
  const lines: string[] = [];
  const io: BackupIo = {
    env: {
      FRM_HOME: w.h.home,
      // The env source is deliberately the loud one: `frm backup` warns on stderr that a key came
      // from the environment rather than the host store. That warning is correct here, not noise.
      [`FRM_SECRET_${BACKUP_KEY_NAME}`]: key,
    },
    clock: w.h.clock,
    out: (line) => lines.push(line),
    err: (line) => lines.push(line),
  };
  const code = await runBackupCommand(cmd, io);
  return code === 0 ? ok(lines) : refuse(`exit ${code}: ${lines.join(" | ")}`);
}

/**
 * Backup and restore over the smoke's own live database, while the fleet runs on it.
 *
 * The restore goes to a **new path**, never over the live database: this proves the backup decrypts
 * and passes `integrity_check`, which is what the acceptance asks, without taking the fleet's
 * database away from the supervisor still using it.
 */
export async function backupPhase(w: World): Promise<void> {
  const key = testKey();

  const written = await w.h.step(
    "an encrypted backup is written and recorded",
    async () => {
      const lines = await run(w, key, { action: "backup" });
      if (!lines.ok) return lines;
      const line = lines.value.find((l) => l.startsWith("backup    "));
      if (line === undefined)
        return refuse<string>(`no backup line in: ${lines.value.join(" | ")}`);
      const path = line.slice("backup    ".length).split("  ")[0];
      if (path === undefined || !existsSync(path))
        return refuse<string>(`the backup it reported is not on disk: ${line}`);

      // Invariant 5: `frm` writes its own attempts through @bayon/db/operator, and the row is how
      // the operator sees a backup happened at all (GET /fleet reads it).
      const last = await getLastBackup(w.db);
      if (!last.ok) return last;
      const row = last.value ?? undefined;
      const problems =
        row === undefined
          ? ["no backups row was written"]
          : [
              ...(row.outcome === "ok"
                ? []
                : [`the backups row says ${row.outcome}: ${row.error ?? ""}`]),
              ...(row.path === path
                ? []
                : [
                    `the row names ${String(row.path)}, the command wrote ${path}`,
                  ]),
            ];
      return problems.length === 0
        ? ok(path)
        : refuse<string>(problems.join("; "));
    },
  );

  await w.h.step("its restore passes integrity_check", async () => {
    // Its own directory, not FRM_HOME itself: `frm restore` refuses a target whose directory holds
    // a supervisor.lock, and FRM_HOME's does — correctly, since that is a live fleet's home. A
    // check-restore belongs somewhere no supervisor could be running.
    const dir = join(w.h.home, "restore-check");
    mkdirSync(dir, { recursive: true });
    const to = join(dir, "restored.db");
    const lines = await run(w, key, {
      action: "restore",
      file: written,
      to,
      replace: false,
    });
    if (!lines.ok) return lines;
    const integrity = lines.value.find((l) => l.startsWith("integrity "));
    // `restoreBackup` already refuses anything but exactly ["ok"], so reaching here is the proof;
    // the line is asserted too so a future change that stops reporting it cannot pass silently.
    return verdict([
      ...(integrity === "integrity ok"
        ? []
        : [`integrity line was ${String(integrity)}`]),
      ...(existsSync(to) ? [] : [`no database at ${to}`]),
    ]);
  });
}
