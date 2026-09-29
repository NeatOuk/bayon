// A models row's adapter settings (`settings_json`) as SpawnSpec.modelSettings carries
// them: parsed as an object and handed on unread (Invariant 1: the adapter owns their meaning, and
// its validateModel accepted them when the operator wrote them). An empty object is no settings.
import { err, ok, type Result } from "@bayon/core";
import { z } from "zod";
import { frmError } from "./errors.js";

const Settings = z.record(z.string(), z.unknown());

/** `{ modelSettings }` to spread into a SpawnSpec, or `{}` when the row has none. */
export function modelSettingsOf(row: {
  readonly id: string;
  readonly settings_json: string;
}): Result<{ readonly modelSettings?: Readonly<Record<string, unknown>> }> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.settings_json) as unknown;
  } catch {
    parsed = undefined;
  }
  const settings = Settings.safeParse(parsed);
  if (!settings.success) {
    return err(
      frmError(
        "validation",
        `model ${row.id}: settings_json is not a JSON object`,
      ),
    );
  }
  return ok(
    Object.keys(settings.data).length === 0
      ? {}
      : { modelSettings: settings.data },
  );
}
