// The worktree sweep's pure rules (§9.6 step 6, §9.2; the design): which rows it
// visits and which it may remove (§3), what a worktree's HEAD proves (§5.1), which ignored entries
// are disposable (Q5, N2), and how git's NUL-delimited listings read. The supervisor gathers the
// facts; nothing here touches git or the filesystem.
import { z } from "zod";
import { CONTEXT_STORE_NAME } from "../context/constants.js";
import type { TicketStatus } from "../laws/statuses.js";
import type { SessionState } from "../states.js";

/** worktrees.kept_reason (015): why a kept worktree needs a human. NULL means nothing to flag. */
export const WorktreeKeptReason = z.enum([
  "dirty",
  "ignored",
  "locked",
  "unpublished",
  "unverifiable",
  "remove_failed",
]);
export type WorktreeKeptReason = z.infer<typeof WorktreeKeptReason>;

/** kept_detail's cap: paths, a lock reason, a SHA or git's stderr tail, never file content. */
export const KEPT_DETAIL_CAP = 500;

export function capDetail(detail: string): string {
  return detail.length <= KEPT_DETAIL_CAP
    ? detail
    : `${detail.slice(0, KEPT_DETAIL_CAP - 1)}…`;
}

/**
 * Ticket statuses whose worktrees may go (§3, M2): staffPlanFor never takes a hand-off on them, and
 * a split parent only closes once no worktree is active. `parked` joins this set for  * close_out edge (parked → done): without it, no parked ticket's worktree can ever leave `active`,
 * so `no_active_worktree` could never clear from the one status close_out starts from. Safe because
 * sweep never force-removes a dirty or unpublished worktree (it flags and keeps those), and a
 * restaffed ticket gets a fresh worktree from the mirror clone at spawn — nothing is lost.
 */
export const SWEEPABLE_STATUSES = [
  "done",
  "rejected",
  "split",
  "parked",
] as const satisfies readonly TicketStatus[];

export const isSweepable = (status: string | null): boolean =>
  status !== null && (SWEEPABLE_STATUSES as readonly string[]).includes(status);

/** A holder in one of these never comes back to its worktree (a resumable one may). */
const ENDED_FOR_GOOD: readonly SessionState[] = ["exited", "handed_off"];

/** What §3 decides on, for one worktree row. */
export interface SweepRow {
  readonly executorKind: string | null;
  readonly holderId: string | null;
  readonly holderState: SessionState | null;
  readonly holderEndedAt: number | null;
  readonly holderGateId: string | null;
  readonly ticketId: string | null;
  readonly ticketStatus: string | null;
  /** An unaccepted hand-off from the holder, or the holder's own incoming one. */
  readonly unacceptedHandoff: boolean;
  /** A session spawned for such a hand-off that has not ended. */
  readonly liveSuccessor: boolean;
}

export type SweepSkip =
  "not_local" | "no_holder" | "holder_not_ended" | "holder_live" | "held";

/**
 * Why the sweep leaves a row alone, or null to visit it (§3 rules 1–5). Rule 1 comes first: a
 * container row's path is the docker host's and must never be looked at here.
 */
export function sweepVisit(
  row: SweepRow,
  live: ReadonlySet<string>,
): SweepSkip | null {
  if (row.executorKind !== "local") return "not_local";
  if (row.holderId === null || row.holderState === null) return "no_holder";
  if (!ENDED_FOR_GOOD.includes(row.holderState)) return "holder_not_ended";
  if (live.has(row.holderId)) return "holder_live";
  // A hand-off on a sweepable ticket is never taken, unless a successor for it is still live.
  if (
    row.unacceptedHandoff &&
    (!isSweepable(row.ticketStatus) || row.liveSuccessor)
  ) {
    return "held";
  }
  return null;
}

export type NotRemovable = "ticket_open" | "no_ended_at" | "ended_recently";

/**
 * Why a visited row may not be removed, or null (§3 "Removable"; M5; NEW-7). A reviewer's row is
 * never a gate subject, so its ticket does not hold it; a NULL ended_at never proves the end.
 */
export function removable(
  row: Pick<
    SweepRow,
    "holderGateId" | "ticketId" | "ticketStatus" | "holderEndedAt"
  >,
  now: number,
  minEndedMs: number,
): NotRemovable | null {
  const byTicket =
    row.holderGateId !== null ||
    row.ticketId === null ||
    isSweepable(row.ticketStatus);
  if (!byTicket) return "ticket_open";
  if (row.holderEndedAt === null) return "no_ended_at";
  if (row.holderEndedAt > now - minEndedMs) return "ended_recently";
  return null;
}

/**
 * What a worktree's HEAD proves (§5.1): `merged` needs nothing more, `own_branch` goes only with an
 * archive bundle (NEW-2), `unmerged` is kept unflagged, `unpublished` is flagged.
 */
export type HeadFate = "merged" | "own_branch" | "unmerged" | "unpublished";

export function headFate(f: {
  /** The holder is a gate reviewer: it has no commits of its own. */
  readonly reviewer: boolean;
  readonly sweepable: boolean;
  /** HEAD is an ancestor of the base ref. */
  readonly onBase: boolean;
  /** HEAD is reachable from refs/heads, refs/tags or refs/frm of the mirror. */
  readonly onSharedRef: boolean;
}): HeadFate {
  if (f.onBase) return "merged";
  if (f.reviewer) return f.onSharedRef ? "merged" : "unpublished";
  if (!f.sweepable) return "unmerged";
  return f.onSharedRef ? "own_branch" : "unpublished";
}

/** The fixed rule's entry (N2): `.foreman/` at a worktree's root, never from the setting. */
export const FOREMAN_ENTRY = ".foreman/";
const FOREMAN_PACKET = /^handoff-\d+\.md$/;

/**
 * Whether a root `.foreman/` holds nothing but hand-off packets (their text is in handoffs) and the
 * context store (M12: originals of compressed tool results, which the raw log also keeps).
 */
export const foremanPacketsOnly = (names: readonly string[]): boolean =>
  names.every(
    (name) => name === CONTEXT_STORE_NAME || FOREMAN_PACKET.test(name),
  );

/**
 * Whether one `!!` entry of `status --ignored=matching` is disposable under
 * worktree.disposable_ignored (Q5): a name ending in `/` matches a directory of that name at any
 * depth, or anything under one; a name without `/` matches a file of that name. No globs, and
 * `.foreman` is never matched here (its rule is fixed).
 */
export function disposableIgnored(
  entry: string,
  names: readonly string[],
): boolean {
  const isDir = entry.endsWith("/");
  const segments = entry.split("/").filter((s) => s !== "");
  if (segments.length === 0 || segments.some((s) => s === "." || s === "..")) {
    return false;
  }
  const dirs = isDir ? segments : segments.slice(0, -1);
  return names.some((name) => {
    const bare = name.endsWith("/") ? name.slice(0, -1) : name;
    if (bare === "" || bare.includes("/") || bare === ".foreman") return false;
    return name.endsWith("/")
      ? dirs.includes(bare)
      : !isDir && segments.at(-1) === bare;
  });
}

/** One entry of `status --porcelain=v1 -z`. */
export interface StatusEntry {
  readonly code: string;
  readonly path: string;
}

/** `status --porcelain=v1 -z`: `XY path` records; a rename or copy carries its source next. */
export function parseStatusZ(out: string): StatusEntry[] {
  const fields = out.split("\0");
  const entries: StatusEntry[] = [];
  for (let i = 0; i < fields.length; i += 1) {
    const field = fields[i] ?? "";
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    entries.push({ code, path: field.slice(3) });
    if (/[RC]/.test(code)) i += 1;
  }
  return entries;
}

/**
 * The paths `ls-files -v -z` tags assume-unchanged (a lowercase tag) or skip-worktree (`S`): status
 * shows nothing for them, and `worktree remove` deletes their changes (g13).
 */
export function hiddenIndexBits(out: string): string[] {
  return out.split("\0").flatMap((field) => {
    if (field.length < 3 || field[1] !== " ") return [];
    const tag = field[0] ?? "";
    const hidden = tag === "S" || tag !== tag.toUpperCase();
    return hidden ? [field.slice(2)] : [];
  });
}

/** One entry of `ls-files -s -z`. */
export interface StagedEntry {
  readonly mode: string;
  readonly path: string;
}

export const GITLINK_MODE = "160000";

/** `ls-files -s -z`: `<mode> <sha> <stage>\t<path>` records. */
export function parseLsFilesStageZ(out: string): StagedEntry[] {
  return out.split("\0").flatMap((field) => {
    const tab = field.indexOf("\t");
    if (tab < 0) return [];
    const mode = field.slice(0, tab).split(" ")[0] ?? "";
    return [{ mode, path: field.slice(tab + 1) }];
  });
}

/** A temp dir ensureMirror left beside `mirrorBase`: `.<base>.clone-XXXXXX`. */
export function isStaleCloneName(name: string, mirrorBase: string): boolean {
  const prefix = `.${mirrorBase}.clone-`;
  return (
    name.startsWith(prefix) &&
    /^[A-Za-z0-9]{6}$/.test(name.slice(prefix.length))
  );
}

export interface SweepFlag {
  readonly reason: WorktreeKeptReason;
  readonly detail: string;
}

export type KeepWhy = "unmerged" | NotRemovable | "removal_off";

export type SweepVerdict =
  | { readonly kind: "remove" }
  | ({ readonly kind: "flag" } & SweepFlag)
  | { readonly kind: "keep"; readonly why: KeepWhy };

/**
 * The row's verdict once its checks ran: the first flag decides; a clean row goes only when its HEAD
 * is publishable, it is removable, and removal is on (a malformed setting turns it off, NEW-7).
 */
export function sweepVerdict(f: {
  readonly flag: SweepFlag | null;
  readonly publishable: boolean;
  readonly notRemovable: NotRemovable | null;
  readonly removalOn: boolean;
}): SweepVerdict {
  if (f.flag !== null) return { kind: "flag", ...f.flag };
  if (!f.publishable) return { kind: "keep", why: "unmerged" };
  if (f.notRemovable !== null) return { kind: "keep", why: f.notRemovable };
  if (!f.removalOn) return { kind: "keep", why: "removal_off" };
  return { kind: "remove" };
}
