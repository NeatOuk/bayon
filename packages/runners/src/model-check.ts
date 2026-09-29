// The default of the `validateModel` hook, runner-neutral: an adapter that declares no
// rules of its own vouches only for the model strings it registers, and has no per-model settings.
import { err, ok, type Result } from "@bayon/core";
import type { ModelContext, ModelProposal } from "./adapter.js";
import { frmError } from "./errors.js";

/**
 * Accepts a model string the adapter registered (in any tier, at any price) and nothing else; any
 * setting is refused, since such an adapter reads none. The operator re-prices, re-tiers or turns
 * off what the adapter ships; a new model string needs an adapter that says what it may be.
 */
export function acceptRegisteredModels(
  row: ModelProposal,
  ctx: ModelContext,
): Result<void> {
  if (!ctx.registered.includes(row.model)) {
    return err(
      frmError(
        "validation",
        `model ${JSON.stringify(row.model)} is not one this runner registers (${ctx.registered.join(", ") || "none"}): its adapter accepts only its own models`,
      ),
    );
  }
  const keys = Object.keys(row.settings);
  if (keys.length > 0) {
    return err(
      frmError(
        "validation",
        `this runner's models take no settings (got ${keys.join(", ")})`,
      ),
    );
  }
  return ok(undefined);
}

/**
 * The ports Bayon's own API and GUI listen on by default: the API's FRM_API_PORT default (3010)
 * and the GUI's (5173, the dev server and the edge alike). A model setting that points a runner's
 * sandbox at one of them would open it to the model, so an adapter refuses them. They are the
 * apps' defaults, repeated here because this package cannot import the apps.
 */
export const BAYON_DEFAULT_PORTS: readonly number[] = [3010, 5173];

const portIn = (text: string | undefined): readonly number[] => {
  if (text === undefined || text.trim() === "") return [];
  const n = Number(text.trim());
  return Number.isInteger(n) && n > 0 && n < 65_536 ? [n] : [];
};

const urlPort = (text: string | undefined): readonly number[] => {
  if (text === undefined) return [];
  try {
    return portIn(new URL(text).port);
  } catch {
    return [];
  }
};

/**
 * The ports Bayon itself listens on, read the way the API (FRM_API_PORT) and the edge
 * (FRM_WEB_PORT) read them, plus frm's own API address (FRM_API_URL) and the defaults — so a port
 * the process cannot see is still refused when it is the usual one.
 */
export function reservedPortsFrom(
  env: Readonly<Record<string, string | undefined>>,
): readonly number[] {
  return [
    ...new Set([
      ...BAYON_DEFAULT_PORTS,
      ...portIn(env["FRM_API_PORT"]),
      ...portIn(env["FRM_WEB_PORT"]),
      ...urlPort(env["FRM_API_URL"]),
    ]),
  ];
}
