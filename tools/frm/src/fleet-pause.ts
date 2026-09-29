// `frm pause` and `frm resume` (M4 §12.1, §13.3): the kill switch from a shell. Through
// the API (FRM_API_URL, else this home's own port, with FRM_API_TOKEN or this home's stored bearer;
//), so it is the same
// audited write the GUI's switch makes. When the API does not answer (refused, unreachable, or no
// answer within API_TIMEOUT_MS), or no token is set, it writes the database itself ($FRM_DB, else
// $FRM_HOME/foreman.db) through @bayon/db/operator, audited as the operator's with via 'frm'. An
// API that answers with an error is believed: nothing is written behind its back.
// Exit codes: 0 done, 1 refused or failed, 2 no database to fall back to.
import { err, ok, type Clock, type Result } from "@bayon/core";
import { openDb } from "@bayon/db";
import {
  setFleetPausedFromCli,
  type FleetPauseChange,
} from "@bayon/db/operator";
import { ApiErrorBody, FleetPauseState } from "@bayon/proto";
import { z } from "zod";
import { dbPathOf } from "./db-path.js";
import type { KeychainOptions } from "@bayon/executors";
import { NO_API_TOKEN, apiBaseOf, apiEnvOf, apiTokenOf } from "./api-access.js";
import { shownHome, type HomeEnv } from "./home.js";
import type { Fetch } from "./smoke/api-client.js";

/** How long the stored bearer's Keychain read may take before the pause goes on without it. */
export const KEYCHAIN_WAIT_MS = 2_000;

/** A pause is an emergency: an API that has not answered by then counts as down. */
export const API_TIMEOUT_MS = 5_000;

export const FLEET_USAGE = [
  "       frm pause | frm resume",
  "pause: holds the fleet until resumed: new spawns and new turns wait (fleet_paused), turns in",
  "  flight and hand-off packets finish, the pulse scheduler freezes and no reviewer launches.",
  "resume: lifts it; admission's next recheck admits what it queued. Both go through the API",
  "  (FRM_API_URL, else this home's port; FRM_API_TOKEN, else this home's stored token); when it does not answer, or",
  "  no token is set, straight into $FRM_DB (else $FRM_HOME/foreman.db). Audited either way.",
].join("\n");

export interface FleetCommand {
  readonly paused: boolean;
}

/** `frm pause` or `frm resume`: argv from the command word on. */
export function parseFleetCli(argv: readonly string[]): Result<FleetCommand> {
  const [word, ...rest] = argv;
  if ((word !== "pause" && word !== "resume") || rest.length > 0) {
    return err({
      class: "validation",
      message: "usage: frm pause | frm resume (no arguments)",
      retryable: false,
    });
  }
  return ok({ paused: word === "pause" });
}

export interface FleetIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly clock: Clock;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly fetch?: Fetch;
  /** The `security` binary the bearer is read with; tests point it at a stand-in. */
  readonly keychain?: KeychainOptions;
  /**
   * The home to fall back to when the env names none (main passes the default ~/.foreman). Asked
   * only when the database is the door, so a pause the API takes never touches a home.
   */
  readonly home?: () => Result<HomeEnv>;
}

const isSet = (value: string | undefined): boolean =>
  value !== undefined && value !== "";

/**
 * The env the database fallback runs on. The default home only when the operator named no API: with
 * FRM_API_URL set they aimed at another install, whose database ~/.foreman's is not.
 */
function fallbackEnv(io: FleetIo): Result<HomeEnv> {
  if (
    isSet(io.env["FRM_HOME"]) ||
    isSet(io.env["FRM_DB"]) ||
    io.home === undefined
  )
    return ok({ env: io.env, defaulted: null });
  if (isSet(io.env["FRM_API_URL"]))
    return err({
      class: "validation",
      message:
        "set FRM_HOME (or FRM_DB) to the database behind FRM_API_URL: frm does not write the default ~/.foreman's in its place",
      retryable: false,
    });
  return io.home();
}

/** The API door's io: see apiEnvOf. A pause with a token in hand never resolves a home. */
const apiDoorIo = (io: FleetIo): FleetIo => ({
  ...io,
  env: apiEnvOf(io.env, io.home),
});

type ApiOutcome =
  | { readonly kind: "done"; readonly state: FleetPauseState }
  | { readonly kind: "refused"; readonly message: string }
  | { readonly kind: "down"; readonly message: string };

const describe = (cause: unknown): string => {
  if (!(cause instanceof Error)) return String(cause);
  const inner = cause.cause instanceof Error ? `: ${cause.cause.message}` : "";
  return `${cause.message}${inner}`;
};

async function viaApi(
  paused: boolean,
  token: string,
  io: FleetIo,
): Promise<ApiOutcome> {
  const origin = apiBaseOf(io.env);
  if (!origin.ok) return { kind: "down", message: origin.error.message };
  const base = origin.value;
  const url = `${base}/api/v1/fleet/${paused ? "pause" : "resume"}`;
  const fetcher: Fetch = io.fetch ?? ((u, init) => fetch(u, init));
  let res: Response;
  try {
    res = await fetcher(url, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
  } catch (cause) {
    return { kind: "down", message: describe(cause) };
  }
  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok) {
    const e = ApiErrorBody.safeParse(json);
    return {
      kind: "refused",
      message: e.success ? e.data.error.message : `HTTP ${res.status}`,
    };
  }
  const state = FleetPauseState.safeParse(json);
  return state.success
    ? { kind: "done", state: state.data }
    : {
        kind: "refused",
        message: `an answer that is not a pause state: ${z.prettifyError(state.error)}`,
      };
}

async function viaDb(
  paused: boolean,
  path: string,
  io: FleetIo,
): Promise<Result<FleetPauseChange>> {
  const opened = await openDb({ path, clock: io.clock });
  if (!opened.ok) return opened;
  try {
    return await setFleetPausedFromCli(opened.value, paused);
  } finally {
    await opened.value.close();
  }
}

const said = (
  s: { readonly paused: boolean; readonly changed: boolean },
  door: string,
): string =>
  `${s.changed ? "" : "already "}${s.paused ? "paused" : "running"} (via ${door})`;

/** Runs `frm pause` or `frm resume`. */
export async function runFleetCommand(
  cmd: FleetCommand,
  io: FleetIo,
): Promise<number> {
  const name = `frm ${cmd.paused ? "pause" : "resume"}`;
  // The default home is resolved at most once, whichever door asks first.
  const asked = io.home;
  let resolved: Result<HomeEnv> | undefined;
  io = {
    ...io,
    ...(asked === undefined ? {} : { home: () => (resolved ??= asked()) }),
  };
  const apiIo = apiDoorIo(io);
  // A pause is an emergency: a Keychain that does not answer quickly (a locked one's prompt) is
  // no token, and the database door takes it.
  const read = await apiTokenOf(apiIo.env, {
    ...io.keychain,
    timeoutMs: io.keychain?.timeoutMs ?? KEYCHAIN_WAIT_MS,
  });
  const token = read.ok ? read.value : undefined;
  let why = read.ok ? NO_API_TOKEN : read.error.message;
  if (token !== undefined) {
    const api = await viaApi(cmd.paused, token, apiIo);
    if (api.kind === "done") {
      io.out(`fleet ${said(api.state, "the API")}`);
      return 0;
    }
    if (api.kind === "refused") {
      io.err(`${name}: the API refused it: ${api.message}`);
      return 1;
    }
    why = `the API did not answer (${api.message})`;
  }
  const home = fallbackEnv(io);
  const path = home.ok
    ? dbPathOf(
        home.value.env,
        "the database to write when the API does not answer",
      )
    : home;
  if (!path.ok) {
    io.err(`${name}: ${why}, and ${path.error.message}`);
    return 2;
  }
  if (home.ok && home.value.defaulted !== null)
    io.err(`(using ${shownHome(home.value.defaulted)})`);
  io.err(`${name}: ${why}; writing ${path.value} directly`);
  const written = await viaDb(cmd.paused, path.value, io);
  if (!written.ok) {
    io.err(`${name}: ${written.error.message}`);
    return 1;
  }
  io.out(`fleet ${said(written.value, "the database")}`);
  return 0;
}
