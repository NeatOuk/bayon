// A runner's own release version, e.g. an npm package's, compared without a semver dependency
// (the runner update check). Deliberately narrow: three numeric parts and an optional
// short prerelease tag, which is every version these runners' packages actually publish.
import { z } from "zod";

/** `1.2.3` or `1.2.3-beta.1`; at most 64 characters altogether. */
export const RELEASE_VERSION = z
  .string()
  .max(64)
  .regex(/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]{1,32})?$/);

interface Parsed {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  /** null for a release; a prerelease sorts below the release it precedes. */
  readonly prerelease: string | null;
}

function parse(version: string): Parsed | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/.exec(version);
  if (m === null) return null;
  const [, major, minor, patch, prerelease] = m;
  return {
    major: Number(major),
    minor: Number(minor),
    patch: Number(patch),
    prerelease: prerelease ?? null,
  };
}

/** A numeric identifier's digits, capped per semver §11's precision note: no runner publishes one
 * this long, so a longer run of digits is treated as non-numeric (alphanumeric) rather than parsed. */
const MAX_NUMERIC_IDENTIFIER_DIGITS = 15;

/** True if `id` is a semver "numeric identifier": digits only, within the precision cap. */
function isNumericIdentifier(id: string): boolean {
  return /^\d+$/.test(id) && id.length <= MAX_NUMERIC_IDENTIFIER_DIGITS;
}

/**
 * Compares two prerelease strings per semver §11: split on '.', identifiers compared left to
 * right; numeric identifiers compare numerically and are always lower than alphanumeric ones;
 * alphanumeric identifiers compare lexically (ASCII); a shorter set of identifiers is lower when
 * all shared identifiers are equal.
 */
function comparePrerelease(a: string, b: string): number {
  const as = a.split(".");
  const bs = b.split(".");
  const len = Math.max(as.length, bs.length);
  for (let i = 0; i < len; i++) {
    const ai = as[i];
    const bi = bs[i];
    if (ai === undefined) return -1; // a ran out first: shorter set is lower
    if (bi === undefined) return 1;
    if (ai === bi) continue;
    const aNum = isNumericIdentifier(ai);
    const bNum = isNumericIdentifier(bi);
    if (aNum && bNum) {
      const diff = Number(ai) - Number(bi);
      if (diff !== 0) return diff < 0 ? -1 : 1;
      continue;
    }
    if (aNum !== bNum) return aNum ? -1 : 1; // numeric < alphanumeric
    return ai < bi ? -1 : 1; // both alphanumeric: ASCII order
  }
  return 0;
}

/**
 * Positive if `a` is newer than `b`, negative if older, zero if equal or if either does not parse
 * as `RELEASE_VERSION` (unparseable is never treated as newer). A release beats its own prerelease.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parse(a);
  const pb = parse(b);
  if (pa === null || pb === null) return 0;
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  if (pa.patch !== pb.patch) return pa.patch - pb.patch;
  if (pa.prerelease === pb.prerelease) return 0;
  if (pa.prerelease === null) return 1; // a release beats its own prerelease
  if (pb.prerelease === null) return -1;
  return comparePrerelease(pa.prerelease, pb.prerelease);
}
