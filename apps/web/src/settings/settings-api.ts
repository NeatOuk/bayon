import type { OperatorSettingsPatch } from "@bayon/core";
import { OperatorSettingsView } from "@bayon/proto";
import { queryOptions } from "@tanstack/react-query";
import { getJson, putJson } from "@/api/http";

// Settings → General's REST (M4 §12.1): GET /settings, every whitelisted key with its
// value and default, and PUT /settings, which the API checks against the same whitelist.

/** GET /settings; a saved change replaces it by this key. */
export const SETTINGS_KEY = ["settings"] as const;

export const settingsQuery = queryOptions({
  queryKey: SETTINGS_KEY,
  queryFn: ({ signal }) => getJson("/settings", OperatorSettingsView, signal),
});

/** The changed keys only; the answer is the whole new view. 400 names a refused key or value. */
export const putSettings = (
  settings: OperatorSettingsPatch,
): Promise<OperatorSettingsView> =>
  putJson("/settings", { settings }, OperatorSettingsView);
