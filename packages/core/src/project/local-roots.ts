// `projects.local_roots` (§14): the folders `POST /projects` may take a bare path from.
// The GUI can be served on the LAN with the operator's bearer added by its proxy, so a path door
// there would let anyone who reaches the page point an agent at any git repo on the host. Off by
// default (`[]`), and a security control (core SHELL_ONLY_SETTINGS): replaced or revoked only through
// the operator door (§9.5), audited. One exception (§14 amendment): `POST /folders/allow`
// may **append** one folder, only for a browser proven to be on the host itself (the web proxy's
// host-only key on a loopback socket), audited as `settings.put` via `gui-local`. `frm project add
// --repo <path>` needs none of it — whoever runs that is already at the operator's shell.
import { z } from "zod";
import { GRANTED_PATH } from "../login-in-place.js";

export const LOCAL_ROOTS_KEY = "projects.local_roots";

/** Absolute folders a project's repo may be a path inside. `[]` (or no row) is off. */
export const LocalRoots = z.array(
  z
    .string()
    .regex(GRANTED_PATH, "not an absolute path without . or .. segments"),
);
export type LocalRoots = z.infer<typeof LocalRoots>;

/** Whether `path` is `root` or below it. Both must be real paths (symlinks resolved) already: a
 * lexical check alone is what a symlink inside a root walks out of. */
export function isInsideRoot(path: string, root: string): boolean {
  return path === root || path.startsWith(`${root}/`);
}
