// What this runner's CLI is started with, env-wise, and the context proxy that may stand before its
// API (spec M12; the pins are). The child env, the inline settings env and the proxy all
// follow one rule: while proxied, the base URL is the proxy's and its bearer rides in the env only.
// And the proxy stays invisible to the CLI's own choices: tool search is kept exactly where the CLI,
// talking to the proxy's upstream directly, would keep it.
import { err, ok, type Result } from "@bayon/core";
import type { Executor } from "@bayon/executors";
import type { SpawnSpec } from "../../adapter.js";
import {
  startSessionProxy,
  type CompressesContext,
  type SessionProxy,
} from "../../context-session.js";
import { frmError } from "../../errors.js";
import {
  PROXY_HEADER,
  type ProxyLog,
  type ProxyTrace,
} from "../../model-proxy.js";
import { CLAUDE_CONTEXT } from "./context.js";
import { DEFAULT_BASE_URL, pinnedEnv } from "./pinned-env.js";

/** A profile's inline `settings.env`: the operator's own, laid over the pins. */
export type ProfileEnv = Readonly<Record<string, unknown>> | undefined;

/** Spec M12: the proxy runs beside the supervisor, so this runner compresses on a local one only. */
export const compressesContext: CompressesContext = (ex) => ex.kind === "local";

/** What the env builders need of a running proxy: where it listens and its bearer. */
export type ProxyAddress = Pick<SessionProxy, "url" | "token">;

/**
 * The CLI's own switch for tool search. Unset, it is on, except that the CLI turns it off when
 * `ANTHROPIC_BASE_URL` names a host other than its first-party one, since a proxy there may not
 * forward `tool_reference` blocks (its debug line names this variable as the override). `true` is
 * the mode an unset variable gives on the first-party host.
 */
export const TOOL_SEARCH_ENV = "ENABLE_TOOL_SEARCH";

/** The host the CLI counts as first party (`new URL(base).host`, checked in 2.1.269 and 2.1.283). */
const FIRST_PARTY_HOST = new URL(DEFAULT_BASE_URL).host;

/**
 * `ENABLE_TOOL_SEARCH=true` for a proxied session whose upstream is the first-party host, where the
 * CLI would keep tool search on without the proxy; nothing for any other upstream (a gateway), where
 * it would not. Nothing either when the operator chose a value, in the session env or the profile's
 * inline settings env ("" counts as unset, as the CLI counts it): theirs stands.
 */
export function toolSearchEnv(
  spec: SpawnSpec,
  profileEnv: ProfileEnv,
): Readonly<Record<string, string>> {
  const chosen = [spec.env[TOOL_SEARCH_ENV], profileEnv?.[TOOL_SEARCH_ENV]];
  if (chosen.some((v) => v !== undefined && v !== "")) return {};
  const upstream = URL.parse(upstreamOf(spec, profileEnv));
  return upstream?.host === FIRST_PARTY_HOST
    ? { [TOOL_SEARCH_ENV]: "true" }
    : {};
}

/**
 * The session env the CLI runs with. While proxied its API base URL is the context proxy, the
 * proxy's bearer is one more header line after any the operator set (in the env only, so it never
 * reaches argv: the pins leave a credential the env holds out of `--settings`), and tool search is
 * as the upstream would have it (toolSearchEnv).
 */
export function sessionEnv(
  spec: SpawnSpec,
  profileEnv: ProfileEnv,
  proxy: ProxyAddress | undefined,
): Readonly<Record<string, string>> {
  if (proxy === undefined) return spec.env;
  const headers = [
    spec.env["ANTHROPIC_CUSTOM_HEADERS"] ?? "",
    `${PROXY_HEADER}: ${proxy.token}`,
  ].filter((line) => line !== "");
  return {
    ...spec.env,
    ...toolSearchEnv(spec, profileEnv),
    ANTHROPIC_BASE_URL: proxy.url,
    ANTHROPIC_CUSTOM_HEADERS: headers.join("\n"),
  };
}

/**
 * The `env` of the inline settings: the pins that keep the repo's own settings files from
 * choosing the credential's host, proxy or TLS trust, then the profile's own settings env. While
 * proxied, the base URL pin is the proxy's, over the profile's too: nothing routes around it; and the
 * tool search switch (toolSearchEnv) is pinned beside it, so no settings source could turn it off
 * should one ever be loaded again.
 */
export function inlineEnv(
  spec: SpawnSpec,
  profileEnv: ProfileEnv,
  proxy?: ProxyAddress,
): Result<Readonly<Record<string, unknown>>> {
  const pins = pinnedEnv(sessionEnv(spec, profileEnv, proxy));
  if (!pins.ok) return pins;
  return ok({
    ...pins.value,
    ...profileEnv,
    ...(proxy === undefined
      ? {}
      : {
          // Nothing when the operator chose a value; over a profile's "" (unset) otherwise.
          ...toolSearchEnv(spec, profileEnv),
          ANTHROPIC_BASE_URL: proxy.url,
        }),
  });
}

/**
 * Where the context proxy sends the CLI's calls: the base URL the operator gave the session (a
 * profile's inline settings win over the session env, as they do for the CLI), else the CLI's own.
 */
export function upstreamOf(spec: SpawnSpec, profileEnv: ProfileEnv): string {
  const inline = profileEnv?.["ANTHROPIC_BASE_URL"];
  if (typeof inline === "string" && inline !== "") return inline;
  const given = spec.env["ANTHROPIC_BASE_URL"];
  return given === undefined || given === "" ? DEFAULT_BASE_URL : given;
}

/**
 * The directories the CLI may use besides its cwd: a multi-repo workspace's other worktrees, and,
 * while proxied, the store of originals, so its read tools open one without a prompt. (It could
 * write there too: this runner has no sandbox, and its shell already runs as the user.)
 */
export function additionalDirectories(spec: SpawnSpec): readonly string[] {
  return [
    ...(spec.extraRoots ?? []),
    ...(spec.contextCompression === undefined
      ? []
      : [spec.contextCompression.storeDir]),
  ];
}

/**
 * The session's context proxy when the spec asks for one (ok(undefined) otherwise). A profile's
 * inline headers are refused while proxied: they would replace the proxy's header, on argv.
 */
export async function startProxy(
  spec: SpawnSpec,
  ex: Pick<Executor, "kind">,
  profileEnv: ProfileEnv,
  report: { readonly log?: ProxyLog; readonly trace?: ProxyTrace },
): Promise<Result<SessionProxy | undefined>> {
  if (
    spec.contextCompression !== undefined &&
    profileEnv?.["ANTHROPIC_CUSTOM_HEADERS"] !== undefined
  ) {
    return err(
      frmError(
        "validation",
        "a profile's inline ANTHROPIC_CUSTOM_HEADERS would replace the context proxy's header on the command line: move it to the profile's env",
      ),
    );
  }
  return startSessionProxy(spec, ex, {
    compresses: compressesContext,
    transform: CLAUDE_CONTEXT,
    upstream: upstreamOf(spec, profileEnv),
    ...(report.log === undefined ? {} : { log: report.log }),
    ...(report.trace === undefined ? {} : { trace: report.trace }),
  });
}
