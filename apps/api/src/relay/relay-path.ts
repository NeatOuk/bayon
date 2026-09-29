// Where the API finds the supervisor's relay socket, and whether to trust it (M4): in
// this home's socket dir (packages/executors' socketDir: FRM_HOME, or a short private dir for a long
// home). Read only: the directory must be this user's own and closed to others, and a socket file
// already there must be this user's. Otherwise the relay (/ws/pty) stays off, with the reason.
import { join } from "node:path";
import { ok, type Result } from "@bayon/core";
import { socketDir, verifySocketDir, verifySocketFile } from "@bayon/executors";

/** The file name beside the control socket (apps/supervisor/src/paths.ts's relaySocketPath). */
export const RELAY_SOCKET = "relay.sock";

export function trustedRelayPath(
  home: string,
  o: { readonly root?: string } = {},
): Result<string> {
  const dir = socketDir(home, o);
  const dirOk = verifySocketDir(dir, home);
  if (!dirOk.ok) return dirOk;
  const path = join(dir, RELAY_SOCKET);
  const fileOk = verifySocketFile(path);
  return fileOk.ok ? ok(path) : fileOk;
}
