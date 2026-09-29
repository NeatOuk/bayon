// Executor mirror names. An executor keeps one mirror per repo, named by the
// repo's id, beside mirrors of its own (the conformance fixture). Repo ids are free text, so the
// executor's own names take a prefix no repo may use: a repo with it would share their mirror.

/** The prefix of mirrors that belong to the executor, never to a repo. */
export const RESERVED_MIRROR_PREFIX = "frm-";

/** Whether `repoId` would name an executor's own mirror. */
export const isReservedRepoId = (repoId: string): boolean =>
  repoId.startsWith(RESERVED_MIRROR_PREFIX);
