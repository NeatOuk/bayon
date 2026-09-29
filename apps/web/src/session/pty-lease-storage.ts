/**
 * Which tab attached: `sessionStorage`, not `localStorage` — this is per-tab "am I the one who
 * attached" continuity (survives a reload of the same tab, never crosses tabs or persists past the
 * browser closing it), not system-of-record state the DB already owns. Every call is defensive:
 * storage can throw (private browsing, blocked site data) and a failure here should never break the
 * Terminal tab, only fall back to "not the holder."
 */
const key = (sessionId: string): string => `pty-lease:${sessionId}`;

export function readLeaseToken(sessionId: string): string | null {
  try {
    return sessionStorage.getItem(key(sessionId));
  } catch {
    return null;
  }
}

export function writeLeaseToken(sessionId: string, token: string): void {
  try {
    sessionStorage.setItem(key(sessionId), token);
  } catch {
    // Best-effort: a tab that can't persist its own token just won't recognize itself on reload.
  }
}

export function clearLeaseToken(sessionId: string): void {
  try {
    sessionStorage.removeItem(key(sessionId));
  } catch {
    // Nothing to clean up if storage was never writable in the first place.
  }
}

/**
 * Is this tab the lease holder? A pure, stateless read-and-compare against whatever `leaseOwner`
 * the server currently reports — never a value adopted once and cached, so there's no window where
 * a different actor's lease could be mistaken for this tab's own, and no special handling needed for
 * a reload: the token was already in storage before this call, same as any other.
 */
export function isLeaseHolderFor(
  sessionId: string,
  leaseOwner: string | null,
): boolean {
  return leaseOwner !== null && leaseOwner === readLeaseToken(sessionId);
}
