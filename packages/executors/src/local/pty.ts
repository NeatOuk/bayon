import { chmod, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { constants } from "node:os";
import { dirname, join } from "node:path";
import type * as NodePty from "node-pty";
import { createChannel } from "../channel.js";
import { frmError, isErrno } from "../errors.js";
import type { Argv, ExitStatus, PtyOpts, PtyProc } from "../types.js";
import { mintRef, signalTree } from "./proc-info.js";

let loaded: Promise<typeof NodePty> | undefined;

/** node-pty loads a native addon when imported, so only a pty() call pays for it. */
function loadNodePty(): Promise<typeof NodePty> {
  loaded ??= ensureSpawnHelper().then(() => import("node-pty"));
  return loaded;
}

// node-pty 1.1.0's macOS prebuilds ship spawn-helper without its exec bit, so every spawn fails
// with "posix_spawnp failed". Linux has no prebuilds and compiles it with the right mode.
async function ensureSpawnHelper(): Promise<void> {
  if (process.platform !== "darwin") return;
  const root = dirname(
    createRequire(import.meta.url).resolve("node-pty/package.json"),
  );
  const helper = join(
    root,
    "prebuilds",
    `${process.platform}-${process.arch}`,
    "spawn-helper",
  );
  const mode = await stat(helper).then(
    (info) => info.mode,
    (err: unknown) => {
      if (isErrno(err, "ENOENT")) return null; // built from source: no prebuild to fix
      throw err;
    },
  );
  if (mode !== null && (mode & 0o111) === 0) await chmod(helper, 0o755);
}

const SIGNAL_NAMES = new Map(
  Object.entries(constants.signals).map(([name, n]) => [n, name]),
);

export async function spawnPty(argv: Argv, opts: PtyOpts): Promise<PtyProc> {
  const [file, ...args] = argv;
  let term: NodePty.IPty;
  try {
    const nodePty = await loadNodePty();
    term = nodePty.spawn(file, args, {
      name: "xterm-256color",
      cols: opts.cols,
      rows: opts.rows,
      cwd: opts.cwd,
      env: { ...opts.env },
    });
  } catch (err) {
    throw frmError("spawn_failed", `cannot start ${file} on a pty`, {
      cause: err,
    });
  }
  const output = createChannel<string>();
  term.onData((data) => output.push(data));
  // Cleared on exit: from then on the pid may be someone else's.
  let running = true;
  const exited = new Promise<ExitStatus>((resolve) => {
    term.onExit(({ exitCode, signal }) => {
      running = false;
      output.close();
      resolve(
        signal === undefined || signal === 0
          ? { code: exitCode, signal: null }
          : { code: null, signal: SIGNAL_NAMES.get(signal) ?? String(signal) },
      );
    });
  });
  const { pid } = term;
  return {
    ref: await mintRef(pid),
    output,
    write: (data) => term.write(data),
    resize: (cols, rows) => term.resize(cols, rows),
    kill: (signal = "SIGTERM") => {
      if (running) signalTree(pid, signal);
    },
    exited,
  };
}
