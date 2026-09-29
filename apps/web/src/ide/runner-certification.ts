import type { RunnerView } from "@bayon/proto";

// A runner's certification on one executor (§15), as the Add agent dialog shows it: the
// operator sees an uncertified pick before making it. The write never waits on it. Certification is
// per model: the runner counts as certified there when every model a role runs is. And
// per context compression: the normal badge counts the certificates earned with it off;
// asked for `compression`, the ones earned with it on, which a project that compresses needs.

/** The executor whose certification the Add agent dialog shows: the one every install has. */
export const CERTIFICATION_EXECUTOR = "local";

export const CERTIFICATION_STATES = [
  "certified",
  "not certified",
  "decertified",
  "never run",
] as const;
export type CertificationState = (typeof CERTIFICATION_STATES)[number];

/**
 * The models whose certification decides the runner's (a certificate holds for one
 * model): the ones a role binding or a project's step tier runs, else every active one.
 */
const modelsThatCount = (runner: RunnerView): readonly string[] => {
  const bound = runner.models.filter((m) => m.bound_roles.length > 0);
  return (bound.length > 0 ? bound : runner.models).map((m) => m.id);
};

/** Which certificates count: those earned with context compression off (the default), or on. */
export interface CertificationKind {
  readonly compression?: boolean;
}

/**
 * `runner` on `executorId`: certified (unattended allowed on every model that counts), not
 * certified (run, but a model that counts has no live certificate), decertified (every certificate
 * there lost), or never run there — counting only the certificates of `kind` (compression off by
 * default: the runner's normal badge).
 */
export function certificationOn(
  runner: RunnerView,
  executorId: string,
  kind: CertificationKind = {},
): CertificationState {
  const compression = kind.compression === true;
  const rows = runner.certifications.filter(
    (c) => c.executor_id === executorId && c.compression === compression,
  );
  if (rows.length === 0) return "never run";
  if (rows.every((c) => c.decertified_at !== null)) return "decertified";
  const live = new Set(
    rows
      .filter((c) => c.passed_at !== null && c.decertified_at === null)
      .map((c) => c.model_id),
  );
  const needed = modelsThatCount(runner);
  return needed.length > 0 && needed.every((m) => live.has(m))
    ? "certified"
    : "not certified";
}

/** `certified on local`, `never run on local`, … (`… with compression` when asked for it). */
export const certificationLabel = (
  runner: RunnerView,
  executorId: string,
  kind: CertificationKind = {},
): string =>
  `${certificationOn(runner, executorId, kind)} on ${executorId}${kind.compression === true ? " with compression" : ""}`;
