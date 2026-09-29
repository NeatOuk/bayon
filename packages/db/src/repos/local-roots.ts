// The GUI's one write to `projects.local_roots` (§14 amendment): append one folder,
// never replace or remove, audited as the operator's with both lists in the same transaction. The
// API calls it only for a request it has proven comes from a browser on this host (apps/api
// folders/local-request.ts); the shell door (`frm settings set`) stays the way to replace or revoke.
// The root is checked by core's own schema, and so is the list already stored: a list that no longer
// parses is refused rather than overwritten.
import {
  LOCAL_ROOTS_KEY,
  LocalRoots,
  err,
  isInsideRoot,
  ok,
  type Result,
} from "@bayon/core";
import { z } from "zod";
import {
  first,
  qb,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import { insertAudit } from "./audit.js";
import { storedJson, upsertSetting } from "./fleet-control.js";

/** The audit payload's `via` for this door: the GUI, from the host itself. */
export const LOCAL_ROOTS_VIA_GUI = "gui-local";

export interface LocalRootAdded {
  /** The root asked for. */
  readonly root: string;
  /** The list after the call. */
  readonly roots: readonly string[];
  /** False when a root already listed covered it: nothing was written or audited. */
  readonly changed: boolean;
}

const invalid = (message: string): Result<never> =>
  err(failure("validation", message));

function storedRoots(ix: Internals): Result<readonly string[]> {
  const row = first(
    ix,
    qb
      .selectFrom("settings")
      .select("value_json")
      .where("key", "=", LOCAL_ROOTS_KEY),
  );
  if (row === undefined) return ok([]);
  const parsed = LocalRoots.safeParse(storedJson(row.value_json));
  return parsed.success
    ? ok(parsed.data)
    : invalid(
        `${LOCAL_ROOTS_KEY} holds something that is not a list of folders; fix it from a shell first: ${z.prettifyError(parsed.error)}`,
      );
}

/** Appends `root` to `projects.local_roots` unless one listed already covers it. */
export function addLocalRoot(
  db: Db,
  root: string,
  /** Who: `operator`. */
  actor: string,
  /** What was asked for, kept in the audit row beside the lists: the path typed and its scope. */
  asked: Readonly<Record<string, string>> = {},
): R<LocalRootAdded> {
  if (actor.trim() === "") {
    return Promise.resolve(invalid("adding an allowed folder needs an actor"));
  }
  const checked = LocalRoots.safeParse([root]);
  if (!checked.success) {
    return Promise.resolve(
      invalid(`${JSON.stringify(root)}: ${z.prettifyError(checked.error)}`),
    );
  }
  return write(db, (ix): Result<LocalRootAdded> => {
    const from = storedRoots(ix);
    if (!from.ok) return from;
    if (from.value.some((listed) => isInsideRoot(root, listed))) {
      return ok({ root, roots: from.value, changed: false });
    }
    const to = [...from.value, root];
    upsertSetting(ix, LOCAL_ROOTS_KEY, JSON.stringify(to), ix.clock.now());
    const audit = insertAudit(ix, {
      actor,
      action: "settings.put",
      target_kind: "setting",
      target_id: LOCAL_ROOTS_KEY,
      payload: { ...asked, via: LOCAL_ROOTS_VIA_GUI, from: from.value, to },
    });
    return audit.ok ? ok({ root, roots: to, changed: true }) : audit;
  });
}
