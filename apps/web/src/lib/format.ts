/** Epoch millis as `YYYY-MM-DD HH:MM` UTC. */
export const formatTime = (ms: number): string =>
  new Date(ms).toISOString().slice(0, 16).replace("T", " ");

/** A 0..1 ratio as a whole percentage, or a dash when it is unknown. */
export const formatPercent = (ratio: number | null): string =>
  ratio === null ? "—" : `${Math.round(ratio * 100)}%`;

const pad = (n: number): string => String(n).padStart(2, "0");

/** Epoch millis as `YYYY-MM-DD HH:MM:SS` in the viewer's timezone. */
export const formatLocalTime = (ms: number): string => {
  const at = new Date(ms);
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
};

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How long before `now` `ms` was, roughly: "just now", "5 min ago", "3 h ago", "2 d ago". */
export function relativeTime(ms: number, now: number): string {
  const ago = Math.max(0, now - ms);
  if (ago < MINUTE) return "just now";
  if (ago < HOUR) return `${Math.floor(ago / MINUTE)} min ago`;
  if (ago < DAY) return `${Math.floor(ago / HOUR)} h ago`;
  return `${Math.floor(ago / DAY)} d ago`;
}

/** Epoch millis as `YYYY-MM-DD HH:MM UTC`: the absolute time behind a relative one (a `title`). */
export const formatUtc = (ms: number): string => `${formatTime(ms)} UTC`;

/**
 * An agent as its rows show it: its kind, its runner and the model its sessions run,
 * which certification is per; the model is left out when none resolves.
 */
export const agentLine = (agent: {
  readonly kind: string;
  readonly runner_id: string;
  readonly model: string | null;
}): string =>
  `${agent.kind} · ${agent.runner_id}${agent.model === null ? "" : ` · ${agent.model}`}`;
