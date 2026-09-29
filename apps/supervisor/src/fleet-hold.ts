// The kill switch as the supervisor's launchers read it (M4 §13.3): `fleet.paused` and
// its last write, read fresh each time the pulse scheduler or the gate engine is about to start
// something. Admission reads the same row for spawns and turns (lifecycle/admission.ts).
import {
  FLEET_PAUSED_KEY,
  fleetHoldOf,
  type FleetHold,
  type Result,
} from "@bayon/core";
import { getSettingRows, type Db } from "@bayon/db";

export async function readFleetHold(db: Db): Promise<Result<FleetHold>> {
  const rows = await getSettingRows(db, [FLEET_PAUSED_KEY]);
  return rows.ok ? fleetHoldOf(rows.value.get(FLEET_PAUSED_KEY)) : rows;
}

/** Whether nothing may launch: paused, or the flag cannot be read (a launcher then waits too). */
export const isHeld = (hold: Result<FleetHold>): boolean =>
  !hold.ok || hold.value.paused;
