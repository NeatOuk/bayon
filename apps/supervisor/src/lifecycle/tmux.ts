// The tmux convention attach.ts and pty-relay.ts both need (§12.5): one session, "main", inside
// each attach lease's own socket. Its own file only so the two modules don't import each other.
import type { Argv } from "@bayon/executors";

export const TMUX_SESSION_NAME = "main";

export function tmuxArgv(socket: string, ...rest: readonly string[]): Argv {
  return ["tmux", "-S", socket, ...rest];
}
