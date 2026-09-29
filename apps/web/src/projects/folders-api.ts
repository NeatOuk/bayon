import {
  FolderAllowed,
  FolderCheck,
  type FolderAllowScope,
} from "@bayon/proto";
import { postJson } from "@/api/http";

// A folder as a project's repo, checked before New project creates anything (//). Whether this browser is on the Bayon host is the server's to say (`local`): the proxy
// decides it from the connection, never from anything this page sends.

/** `POST /folders/check`: what the folder is; writes nothing. */
export const checkFolder = (path: string): Promise<FolderCheck> =>
  postJson("/folders/check", { path }, FolderCheck);

/** `POST /folders/allow`: from a browser on the Bayon host only; appends to the allowed folders. */
export const allowFolder = (request: {
  readonly path: string;
  readonly scope: FolderAllowScope;
  /** The real path the confirm named: the server refuses if it is no longer what would be added. */
  readonly expect_root: string;
}): Promise<FolderAllowed> =>
  postJson("/folders/allow", request, FolderAllowed);

/** `POST /folders/init`: git init and one empty first commit; the check after. */
export const initFolder = (path: string): Promise<FolderCheck> =>
  postJson("/folders/init", { path }, FolderCheck);

/** A path the server judges as a folder, as it does (`POST /projects`): absolute. */
export const isFolderPath = (repoUrl: string): boolean =>
  repoUrl.trim().startsWith("/");
