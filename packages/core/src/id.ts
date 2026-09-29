import { ulid } from "ulid";

/**
 * A new ULID, the id format of every table. Pass `clock.now()` so tests control the time part;
 * omitted (or 0) means the wall clock. Stateless on purpose: ulid's monotonic factory would
 * re-stamp the last time whenever an injected clock runs behind the wall clock.
 */
export const newId = (seedTime?: number): string => ulid(seedTime);
