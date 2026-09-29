// The remote side as the container executor sees it: a fixed command started
// on the docker host, three pipes and an exit. ssh.ts carries it over ssh; loopback.ts runs it
// with the local shell for the tests.
import { spawn, type ChildProcess } from "node:child_process";
import type { Readable, Writable } from "node:stream";
import type { FrmError } from "@bayon/core";
import { frmError } from "../errors.js";

export interface RemoteExit {
  readonly code: number | null;
  readonly signal: string | null;
}

export interface RemoteChild {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  /** Settles when the local end exits; never rejects. */
  readonly exited: Promise<RemoteExit>;
  /** SIGKILLs the local end: the channel closes and the exec-shim's dead-man ends the program. */
  kill(): void;
}

/** A local program that runs a fixed command remotely, for a caller that drives its stdio itself
 * (git's ext:: transport). `release` gives back its channel once it has exited. */
export interface ProgramSpec {
  readonly file: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  release(): void;
}

export interface Transport {
  /** Starts a fixed command; rejects `timeout` if `signal` aborts first. */
  start(command: string, signal: AbortSignal): Promise<RemoteChild>;
  /** What `start` would spawn for `command`, connected and holding a channel, but not started. */
  program(command: string, signal: AbortSignal): Promise<ProgramSpec>;
  /** A failure of the transport itself rather than of the command, or null. */
  transportError(exit: RemoteExit, stderr: string): FrmError | null;
  /** Records one round trip, for `rttMs`. */
  observeRtt(ms: number): void;
  /** A moving average of round trips; null before the first. */
  rttMs(): number | null;
  /** Bounded by `signal`. */
  close(signal: AbortSignal): Promise<void>;
}

export const timeoutError = (what: string): FrmError =>
  frmError("timeout", `${what}: no answer before the deadline`, {
    retryable: true,
  });

/** Resolves once `signal` aborts (at once if it already has). */
export function aborted(signal: AbortSignal): Promise<"aborted"> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve("aborted");
    else
      signal.addEventListener("abort", () => resolve("aborted"), {
        once: true,
      });
  });
}

/** `promise`, or `timeout` once `signal` aborts. */
export async function beforeDeadline<T>(
  promise: Promise<T>,
  signal: AbortSignal,
  what: string,
): Promise<T> {
  const outcome = await Promise.race([
    promise.then((value) => ({ value })),
    aborted(signal),
  ]);
  if (outcome === "aborted") throw timeoutError(what);
  return outcome.value;
}

/** Spawns a local process for a transport; resolves once it runs. */
export async function startChild(
  file: string,
  args: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<RemoteChild> {
  const child = spawn(file, args, {
    env: { ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const exited = new Promise<RemoteExit>((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  await new Promise<void>((resolve, reject) => {
    child.once("spawn", () => resolve());
    child.once("error", (err) =>
      reject(
        frmError("spawn_failed", `cannot start ${file}: ${err.message}`, {
          cause: err,
        }),
      ),
    );
  });
  const { stdin, stdout, stderr } = child;
  if (stdin === null || stdout === null || stderr === null) {
    throw frmError("internal", `${file} started without pipes`);
  }
  // EPIPE once it exits: writers see it through their own callbacks.
  stdin.on("error", () => {});
  return { stdin, stdout, stderr, exited, kill: () => killChild(child) };
}

function killChild(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

export interface Ran {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface RunOptions {
  /** What error messages call it. */
  readonly what: string;
  /** The deadline; the whole call, connect and queueing included, ends by it. */
  readonly signal: AbortSignal;
  readonly input?: string | Uint8Array;
}

const OUTPUT_CAP = 1024 * 1024;

/** Runs a fixed command to its exit before the deadline; a transport failure rejects. */
export async function runRemote(
  transport: Transport,
  command: string,
  o: RunOptions,
): Promise<Ran> {
  const began = Date.now();
  const child = await transport.start(command, o.signal);
  const output = Promise.all([
    readCapped(child.stdout),
    readCapped(child.stderr),
    child.exited,
  ]);
  child.stdin.end(o.input ?? "");
  const outcome = await Promise.race([output, aborted(o.signal)]);
  if (outcome === "aborted") {
    child.kill();
    throw timeoutError(o.what);
  }
  const [stdout, stderr, exit] = outcome;
  const failure = transport.transportError(exit, stderr);
  if (failure !== null) throw failure;
  transport.observeRtt(Date.now() - began);
  return { code: exit.code, stdout, stderr };
}

async function readCapped(stream: Readable): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    if (size < OUTPUT_CAP) chunks.push(bytes);
    size += bytes.length;
  }
  return Buffer.concat(chunks).toString("utf8");
}
