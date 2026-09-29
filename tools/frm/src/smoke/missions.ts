import type { Result } from "@bayon/core";
import { getAgent, type Db } from "@bayon/db";
import type { ApiClient } from "./api-client.js";
import {
  MISSION,
  SMOKE_AGENTS,
  agentId,
  missionHashOf,
  missionRequest,
  type SmokeMission,
} from "./config.js";
import { verdict, type Harness } from "./harness.js";

// Missions go in over REST, as the operator's editor saves them (M1 contract 7): the API is their
// only writer (§9.5) and points each agent at its new version (M1 amendment 6).

/** Saves the agent's v1 and checks it: version 1, the template's hash, the agent repointed. */
async function saveV1(
  api: ApiClient,
  db: Db,
  { name, text }: SmokeMission,
): Promise<Result<void>> {
  const saved = await api.saveMission(name, missionRequest(text));
  if (!saved.ok) return saved;
  const row = await getAgent(db, name);
  if (!row.ok) return row;
  const { id, version, hash } = saved.value;
  const want = await missionHashOf(name, text);
  return verdict([
    ...(version === 1 ? [] : [`saved version ${version}, expected 1`]),
    ...(hash === want ? [] : [`hash ${hash}, expected ${want}`]),
    ...(row.value.mission_id === id
      ? []
      : [`agent ${name} points at ${row.value.mission_id}, not ${id}`]),
  ]);
}

/** One agent's v1 as one step: before its first spawn, which resolves the agent's mission. */
export const saveMission = (
  h: Harness,
  api: ApiClient,
  db: Db,
  name: string,
  text: SmokeMission["text"] = MISSION,
): Promise<void> =>
  h.step(`POST /missions/${name} (v1, agent repointed)`, () =>
    saveV1(api, db, { name, text }),
  );

/** Each mission's v1 (by default every M0 smoke agent's, with MISSION), before any spawn. */
export async function saveMissions(
  h: Harness,
  api: ApiClient,
  db: Db,
  missions: readonly SmokeMission[] = SMOKE_AGENTS.map((a) => ({
    name: agentId(a),
    text: MISSION,
  })),
): Promise<void> {
  for (const m of missions) await saveMission(h, api, db, m.name, m.text);
}
