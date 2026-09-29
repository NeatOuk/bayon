// When a delivery goes: quiet hours, in the API host's local time, and the retry
// backoff. Pure, on epoch millis: the notifier passes its injected clock's now.

/** `notify.quiet_start_hour` and `notify.quiet_end_hour`: 0–23, or -1 for off. */
export interface QuietHours {
  readonly start: number;
  readonly end: number;
}

export const QUIET_OFF: QuietHours = { start: -1, end: -1 };

const HOUR = 3_600_000;

/** Off: either end is -1, or the window is empty (start equals end). */
export const quietOff = (q: QuietHours): boolean =>
  q.start < 0 || q.end < 0 || q.start === q.end;

/** Whether local `hour` is inside the window; one that wraps midnight (22 → 7) is allowed. */
export function isQuietHour(hour: number, q: QuietHours): boolean {
  if (quietOff(q)) return false;
  return q.start < q.end
    ? hour >= q.start && hour < q.end
    : hour >= q.start || hour < q.end;
}

export const isQuiet = (now: number, q: QuietHours): boolean =>
  isQuietHour(new Date(now).getHours(), q);

/**
 * The first local `end`:00 after `now`: when a delivery held by quiet hours goes out. Stepped an hour
 * at a time from the local hour's start, so a DST change moves it with the wall clock.
 */
export function quietEndsAt(now: number, q: QuietHours): number {
  const start = new Date(now);
  start.setMinutes(0, 0, 0);
  let at = start.getTime() + HOUR;
  for (let i = 0; i < 48 && new Date(at).getHours() !== q.end; i += 1)
    at += HOUR;
  return at;
}

/** The waits after the first, second, … failed send: 30 s, 2 m, 10 m, 1 h, 6 h. */
export const NOTIFY_BACKOFF_MS = [
  30_000, 120_000, 600_000, 3_600_000, 21_600_000,
] as const;

/** The first send, then one retry per backoff: a sixth failure is final. */
export const NOTIFY_MAX_ATTEMPTS = NOTIFY_BACKOFF_MS.length + 1;

/**
 * After `attempts` sends of one delivery (1-based, the one just made included): when the next one
 * is due, or null when the retries are spent and the delivery is `failed`.
 */
export function retryAt(attempts: number, now: number): number | null {
  if (attempts < 1 || attempts >= NOTIFY_MAX_ATTEMPTS) return null;
  const wait = NOTIFY_BACKOFF_MS[attempts - 1];
  return wait === undefined ? null : now + wait;
}
