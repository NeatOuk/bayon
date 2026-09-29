import { FrmHttpError } from "../errors.js";

// M1 contract 3: PATCH and transition carry the version they read as `If-Match: "<version>"`
// (a strong ETag, or the bare number). Absent is 428; anything else malformed is 400. A stale
// version is the writer's 409, carrying the current one.

const IF_MATCH = /^(?:"([1-9]\d{0,14})"|([1-9]\d{0,14}))$/;

const invalid = (message: string, status: number) =>
  new FrmHttpError({ class: "validation", message, retryable: false }, status);

/** The version `If-Match` names; throws a 428 or 400 FrmHttpError otherwise. */
export function ifMatchVersion(raw: string | undefined): number {
  if (raw === undefined)
    throw invalid('If-Match: "<version>" is required', 428);
  const match = IF_MATCH.exec(raw.trim());
  const digits = match?.[1] ?? match?.[2];
  if (digits === undefined) {
    throw invalid(
      `If-Match: expected one version like "7", not ${JSON.stringify(raw)}`,
      400,
    );
  }
  return Number(digits);
}
