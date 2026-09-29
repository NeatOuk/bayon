/* global fetch */
// Prints how many sessions have a turn in flight:
// `bayon.sh upgrade` waits for 0 before it stops the supervisor, whose restart interrupts every run in
// flight. Idle, pending and ended sessions do not count: a restart loses no turn of theirs. It runs in
// the api container, with the bearer from that container's file store and the API on its loopback;
// the bearer is never printed.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";

const IN_FLIGHT = new Set([
  "preparing",
  "spawning",
  "running",
  "awaiting_approval",
  "human_attached",
  "handoff_writing",
  "stopping",
]);

try {
  const dir = process.env.FRM_SECRETS_DIR || "/run/secrets";
  const port = process.env.FRM_API_PORT || "3010";
  const token = readFileSync(join(dir, "FRM_API_TOKEN"), "utf8").trim();
  const response = await fetch(`http://127.0.0.1:${port}/api/v1/fleet`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok)
    throw new Error(`HTTP ${response.status} from /api/v1/fleet`);
  const fleet = await response.json();
  const sessions = Array.isArray(fleet?.sessions) ? fleet.sessions : [];
  const live = sessions.filter((session) => IN_FLIGHT.has(session?.state));
  process.stdout.write(`${live.length}\n`);
} catch (e) {
  process.stderr.write(
    `live-sessions: ${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exit(1);
}
