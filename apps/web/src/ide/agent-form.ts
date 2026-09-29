// What the Agents view's fields accept, before `PATCH /agents/:id` or
// `POST /projects/:id/agents` checks it again (proto's `MaxConcurrency`: an int ≥ 0).

/** A whole number ≥ 0 as `max_concurrency` takes it; null for anything else. */
export function slotsOf(text: string): number | null {
  const trimmed = text.trim();
  return /^[0-9]{1,4}$/.test(trimmed) ? Number(trimmed) : null;
}
