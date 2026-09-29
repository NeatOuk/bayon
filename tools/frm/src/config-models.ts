// `frm config apply`'s `models` section: the operator's own models rows, each judged by
// its runner's adapter (validateModel, through @bayon/runners/models) against the runner row the
// supervisor registered, then written with the rest of the file by seedConfig (@bayon/db/operator,
// Invariant 5). A row whose adapter settings change — a provider URL directs network egress — is a
// security change like `frm settings set`'s: it is shown, and written only with --yes.
import { err, ok, systemClock, type Result } from "@bayon/core";
import {
  getRunner,
  listModels,
  openDb,
  type Db,
  type ModelRow,
} from "@bayon/db";
import type { OperatorModel } from "@bayon/db/operator";
import type { ModelInput } from "@bayon/proto";
import {
  checkOperatorModel,
  reservedPortsFrom,
  settingsNoteFor,
} from "@bayon/runners/models";
import { dbPathOf } from "./db-path.js";

export interface ModelsPlan {
  readonly rows: readonly OperatorModel[];
  /** One line per row whose settings this apply changes: what --yes consents to. */
  readonly settingsChanges: readonly string[];
}

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

/**
 * The model strings a runner's adapter registers now (its adapter rows not retired), and the row's
 * own stored string: fixed once stored, it was judged when first written — an adapter row the
 * operator took over is no longer an adapter row.
 */
const registeredOf = (
  rows: readonly ModelRow[],
  runnerId: string,
  id: string,
) =>
  rows
    .filter(
      (m) =>
        m.runner_id === runnerId &&
        ((m.source === "adapter" && m.retired_at === null) || m.id === id),
    )
    .map((m) => m.model);

/** Each row checked and filled in, and the settings changes among them. Reads only. */
export async function planModels(
  db: Db,
  inputs: readonly ModelInput[],
  env: Readonly<Record<string, string | undefined>> = {},
): Promise<Result<ModelsPlan>> {
  const ids = inputs.map((m) => m.id);
  const repeated = ids.find((id, i) => ids.indexOf(id) !== i);
  if (repeated !== undefined)
    return invalid(`models: ${repeated} is listed twice`);
  if (inputs.length === 0) return ok({ rows: [], settingsChanges: [] });
  const stored = await listModels(db);
  if (!stored.ok) return stored;
  const rows: OperatorModel[] = [];
  const settingsChanges: string[] = [];
  for (const input of inputs) {
    const runner = await getRunner(db, input.runner_id);
    if (!runner.ok) {
      return runner.error.class === "not_found"
        ? invalid(
            `model ${input.id}: runner ${input.runner_id} is not registered: boot the supervisor, then apply again`,
          )
        : runner;
    }
    const checked = checkOperatorModel(input, {
      id: runner.value.id,
      defaults_json: runner.value.defaults_json,
      registered: registeredOf(stored.value, runner.value.id, input.id),
      reservedPorts: reservedPortsFrom(env),
    });
    if (!checked.ok) return checked;
    rows.push(checked.value);
    const before =
      stored.value.find((m) => m.id === input.id)?.settings_json ?? "{}";
    if (before !== checked.value.settings_json) {
      // In the adapter's own words (Invariant 1): what the new settings open on the network.
      const opens = settingsNoteFor(runner.value.id, input.settings ?? {});
      const consequence =
        opens === null
          ? "this lapses the model's certificate"
          : `${opens}, and lapses the model's certificate`;
      settingsChanges.push(
        `model ${input.id}: settings ${before} -> ${checked.value.settings_json}: ${consequence}`,
      );
    }
  }
  return ok({ rows, settingsChanges });
}

export interface ModelsListIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const priceText = (p: number | null): string => (p === null ? "-" : String(p));

/** One line per model: what the Runners page shows, for the shell. */
export function modelLine(m: ModelRow): string {
  const prices = [
    m.price_in_per_mtok,
    m.price_out_per_mtok,
    m.price_cache_read_per_mtok,
    m.price_cache_write_per_mtok,
  ]
    .map(priceText)
    .join("/");
  return [
    m.id,
    m.runner_id,
    m.tier,
    m.model,
    m.active === 1 ? "active" : "inactive",
    m.source,
    `usd/mtok in/out/cache-read/cache-write ${prices}`,
    `context ${m.context_tokens ?? "-"}`,
    ...(m.effort === null ? [] : [`effort ${m.effort}`]),
    ...(m.settings_json === "{}" ? [] : [`settings ${m.settings_json}`]),
  ].join("  ");
}

/** `frm models list [runner]`: every non-retired model, by runner, active first. Reads only. */
export async function runModelsList(
  runner: string | undefined,
  io: ModelsListIo,
): Promise<number> {
  const path = dbPathOf(io.env, "the database the models are in");
  if (!path.ok) {
    io.err(`frm models list: ${path.error.message}`);
    return 2;
  }
  const opened = await openDb({ path: path.value, clock: systemClock });
  if (!opened.ok) {
    io.err(`frm models list: ${opened.error.message}`);
    return 1;
  }
  try {
    const rows = await listModels(opened.value);
    if (!rows.ok) {
      io.err(`frm models list: ${rows.error.message}`);
      return 1;
    }
    const shown = rows.value
      .filter(
        (m) =>
          m.retired_at === null &&
          (runner === undefined || m.runner_id === runner),
      )
      .toSorted(
        (a, b) =>
          a.runner_id.localeCompare(b.runner_id) ||
          b.active - a.active ||
          a.id.localeCompare(b.id),
      );
    if (shown.length === 0) {
      io.err(
        `frm models list: no models${runner === undefined ? "" : ` of runner ${runner}`}`,
      );
      return 1;
    }
    for (const m of shown) io.out(modelLine(m));
    return 0;
  } finally {
    await opened.value.close();
  }
}
