// The supervisor-held reverse tunnel for /mcp: one `ssh -N -R
// <remote_root>/run/mcp.sock:<api host>:<api port>` per container executor, its own connection
// (never the multiplexed master, which idles out), restarted with backoff whenever it exits.
// The gateway's socat relays the internal network's :mcp_port to that socket.
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { frmError } from "../errors.js";
import { commonArgs, destination, type SshTarget } from "./ssh.js";

const HOST = /^[A-Za-z0-9.-]{1,253}$/;

export interface Backoff {
  readonly minMs: number;
  readonly maxMs: number;
  /** A tunnel that stayed up this long starts over at `minMs`. */
  readonly stableMs: number;
}

export const DEFAULT_BACKOFF: Backoff = {
  minMs: 1_000,
  maxMs: 60_000,
  stableMs: 60_000,
};

/** The wait before restart `attempt` (0-based): doubling from `minMs`, capped at `maxMs`. */
export function backoffMs(
  attempt: number,
  b: Backoff = DEFAULT_BACKOFF,
): number {
  return Math.min(b.maxMs, b.minMs * 2 ** Math.min(attempt, 30));
}

export interface ApiTarget {
  readonly host: string;
  readonly port: number;
}

/** A dedicated connection (ControlPath=none) that exits when the forward cannot bind. */
export function tunnelArgs(
  t: SshTarget,
  socket: string,
  api: ApiTarget,
): string[] {
  if (!HOST.test(api.host) || !Number.isSafeInteger(api.port)) {
    throw frmError(
      "validation",
      `refusing the tunnel target ${api.host}:${api.port}`,
    );
  }
  return [
    ...commonArgs(t, "none"),
    "-N",
    "-o",
    "ControlMaster=no",
    "-o",
    "ExitOnForwardFailure=yes",
    "-R",
    `${socket}:${api.host}:${api.port}`,
    destination(t),
  ];
}

export type TunnelState = "up" | "down";

export interface TunnelOptions {
  readonly target: SshTarget;
  readonly env: Readonly<Record<string, string>>;
  readonly socket: string;
  readonly api: ApiTarget;
  /** ssh's stderr is appended here. */
  readonly log: string;
  /** Removes a stale remote socket before each start; a failure is only logged by ssh's exit. */
  readonly reset: () => Promise<void>;
  readonly backoff?: Backoff;
}

export class McpTunnel {
  readonly #o: TunnelOptions;
  readonly #backoff: Backoff;
  #child: ChildProcess | null = null;
  #timer: NodeJS.Timeout | undefined;
  #attempt = 0;
  #starting = false;
  #stopped = false;

  constructor(o: TunnelOptions) {
    this.#o = o;
    this.#backoff = o.backoff ?? DEFAULT_BACKOFF;
  }

  /** Idempotent: starts the tunnel unless it runs, is starting, or waits out a backoff. */
  start(): void {
    this.#stopped = false;
    if (this.#child !== null || this.#starting || this.#timer !== undefined)
      return;
    void this.#launch();
  }

  state(): TunnelState {
    const c = this.#child;
    return c !== null && c.exitCode === null && c.signalCode === null
      ? "up"
      : "down";
  }

  /** The ssh client's pid while it runs (the live test kills it). */
  pid(): number | null {
    return this.state() === "up" ? (this.#child?.pid ?? null) : null;
  }

  stop(): void {
    this.#stopped = true;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    const c = this.#child;
    this.#child = null;
    if (c !== null && c.exitCode === null && c.signalCode === null)
      c.kill("SIGKILL");
  }

  async #launch(): Promise<void> {
    this.#starting = true;
    try {
      await this.#o.reset().catch(() => undefined);
      if (this.#stopped) return;
      mkdirSync(dirname(this.#o.log), { recursive: true, mode: 0o700 });
      const log = openSync(this.#o.log, "a", 0o600);
      let child: ChildProcess;
      try {
        child = spawn(
          "ssh",
          tunnelArgs(this.#o.target, this.#o.socket, this.#o.api),
          {
            env: { ...this.#o.env },
            detached: true,
            stdio: ["ignore", "ignore", log],
          },
        );
      } finally {
        closeSync(log);
      }
      child.on("error", () => {});
      child.unref();
      const began = Date.now();
      this.#child = child;
      child.once("exit", () => this.#exited(child, Date.now() - began));
    } finally {
      this.#starting = false;
    }
  }

  #exited(child: ChildProcess, livedMs: number): void {
    if (this.#child !== child) return;
    this.#child = null;
    if (this.#stopped) return;
    this.#attempt = livedMs >= this.#backoff.stableMs ? 0 : this.#attempt + 1;
    this.#timer = setTimeout(
      () => {
        this.#timer = undefined;
        if (!this.#stopped) void this.#launch();
      },
      backoffMs(this.#attempt - 1, this.#backoff),
    );
    this.#timer.unref();
  }
}
