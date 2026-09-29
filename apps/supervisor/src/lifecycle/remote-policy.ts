// What a remote read from this host may reach (M2): the repo check and a
// mirror's first clone. Before git runs, the URL passes core's checkOriginUrl (https, ssh or
// scp-style; no plain http, no credential inside it) and the host policy (never link-local or cloud
// metadata; loopback and private networks only when `projects.private_repo_hosts` lists the host),
// judged on the literal host and on what DNS resolves it to now. git then runs with only the
// allowed transports (`remoteProtocolFlags`).
//
// Known gap, said plainly: git resolves the name again when it connects, so a name whose answer
// changes between the two lookups (DNS rebinding) is judged on the first one. The literal check,
// the transport allow-list and the metadata names always hold.
import { lookup } from "node:dns/promises";
import {
  PRIVATE_REPO_HOSTS_KEY,
  PrivateRepoHosts,
  checkOriginUrl,
  err,
  ok,
  repoHostProblem,
  repoUrlHost,
  type Result,
} from "@bayon/core";
import { getSettings, type Db } from "@bayon/db";
import { REMOTE_PROTOCOLS, remoteProtocolFlags } from "@bayon/executors";
import { frmError } from "./errors.js";

export interface RemotePolicy {
  /** The transports git may use; production's is https and ssh only. */
  readonly protocols: readonly string[];
  /** `projects.private_repo_hosts`, read at each check: a change needs no restart. */
  readonly allowedHosts: () => Promise<readonly string[]>;
  /** What `host` resolves to now; none when it does not resolve (git then says so itself). */
  readonly resolve: (host: string) => Promise<readonly string[]>;
}

/** The addresses DNS gives `host` now, or none. */
export async function dnsResolve(host: string): Promise<readonly string[]> {
  try {
    return (await lookup(host, { all: true, verbatim: true })).map(
      (a) => a.address,
    );
  } catch {
    return [];
  }
}

/** The allowed hosts as stored; a row that does not parse allows none. */
async function storedHosts(db: Db): Promise<readonly string[]> {
  const rows = await getSettings(db, [PRIVATE_REPO_HOSTS_KEY]);
  if (!rows.ok) return [];
  const parsed = PrivateRepoHosts.safeParse(
    rows.value.get(PRIVATE_REPO_HOSTS_KEY) ?? [],
  );
  return parsed.success ? parsed.data : [];
}

export function remotePolicy(
  db: Db,
  o: {
    readonly resolve?: RemotePolicy["resolve"];
    readonly protocols?: readonly string[];
  } = {},
): RemotePolicy {
  return {
    protocols: o.protocols ?? REMOTE_PROTOCOLS,
    allowedHosts: () => storedHosts(db),
    resolve: o.resolve ?? dnsResolve,
  };
}

/** No DNS and no private host: what a caller wired without a policy gets. */
export const LITERAL_POLICY: RemotePolicy = {
  protocols: REMOTE_PROTOCOLS,
  allowedHosts: () => Promise.resolve([]),
  resolve: () => Promise.resolve([]),
};

/**
 * The `-c` flags git reads `url` with, or why it may not (`validation`, in plain words). A
 * `file://` URL passes only when the policy lists `file` — tests, never production.
 */
export async function guardRemote(
  policy: RemotePolicy,
  url: string,
): Promise<Result<readonly string[]>> {
  const localFile =
    policy.protocols.includes("file") && url.startsWith("file://");
  if (!localFile) {
    const shape = checkOriginUrl(url);
    if (!shape.ok) return shape;
    const host = repoUrlHost(url);
    const addresses = host === null ? [] : await policy.resolve(host);
    const problem = repoHostProblem(
      url,
      addresses,
      await policy.allowedHosts(),
    );
    if (problem !== null) return err(frmError("validation", problem));
  }
  return ok(remoteProtocolFlags(policy.protocols));
}
