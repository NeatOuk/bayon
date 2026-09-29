// The OS sandbox opencode runs in on a local macOS executor: a Seatbelt
// profile for `sandbox-exec`, applied to the `opencode acp` process so every tool it runs — the
// model's shell and everything that shell starts — inherits it. opencode's permission rules only
// gate a tool call's text; this is what confines what a call can actually do. Pure.
//
// Seatbelt is last-match-wins, so the order below is the policy:
//   1. everything allowed, then every file write denied;
//   2. writes allowed to the worktree, the session home and the git dirs a commit needs
//      (git-roots.ts: the worktree's own git dir under the mirror, and its objects, refs, logs);
//   3. writes denied again to every git config and hooks dir in reach (the mirror's, and a plain
//      checkout's own `.git`), so no session can plant a hook git would run outside every rule;
//   4. reads denied to the operator's credential stores (keychains, ssh, cloud CLIs, other runners);
//   5. every outbound connection denied but loopback (the host's MCP proxy, opencode's own server)
//      and the model provider's port. Seatbelt cannot name a remote host, only a port.
import { homedir } from "node:os";
import { join } from "node:path";

export const SANDBOX_EXEC = "/usr/bin/sandbox-exec";

/**
 * Where the loopback rule goes. The adapter cannot know the session's ports; the turn host picks
 * them (its MCP proxy's, opencode's own server's) and replaces this comment with one rule per
 * port, so a session can reach its own two and no other session's, nor the supervisor's API.
 */
export const LOOPBACK_MARK = ";; frm:loopback";

export interface SandboxInput {
  /** Real paths (Seatbelt matches resolved paths: /tmp is /private/tmp on macOS). */
  readonly writable: readonly string[];
  /** Writes refused even inside a writable path: git's config and hooks. */
  readonly denyWrite: readonly string[];
  /** Reads refused: the operator's credential stores. */
  readonly denyRead: readonly string[];
  /** Remote TCP ports the model provider listens on. */
  readonly providerPorts: readonly number[];
  /**
   * Loopback ports the adapter itself serves this session on: its context proxy (spec M12), which
   * stands in for the provider while compression is on. Absent: none.
   */
  readonly loopbackPorts?: readonly number[];
  /** The provider is reached by name: allow the resolver's socket. */
  readonly dns: boolean;
}

/** An SBPL string literal. Paths come from the supervisor, but a quote must never end one. */
const lit = (value: string): string => JSON.stringify(value);

/** Credential stores in the operator's home that no session has a reason to read. */
export function credentialStores(home: string = homedir()): readonly string[] {
  return [
    "Library/Keychains",
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".config/gcloud",
    ".kube",
    ".docker",
    ".netrc",
    ".git-credentials",
    ".config/gh",
    ".npmrc",
    ".claude",
    ".claude.json",
    ".codex",
    ".config/opencode",
    ".local/share/opencode",
  ]
    .map((p) => join(home, p))
    .concat(["/Library/Keychains"]);
}

/** Every git config and hooks path under `gitDirs`: what no session may write. */
export const gitGuards = (gitDirs: readonly string[]): readonly string[] =>
  gitDirs.flatMap((dir) => [
    join(dir, "config"),
    join(dir, "config.worktree"),
    join(dir, "hooks"),
  ]);

export function seatbeltProfile(s: SandboxInput): string {
  const paths = (xs: readonly string[]) =>
    xs.map((p) => `  (subpath ${lit(p)})`).join("\n");
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    paths(s.writable),
    '  (literal "/dev/null") (literal "/dev/tty") (literal "/dev/dtracehelper")',
    '  (regex #"^/dev/fd/[0-9]+$"))',
    ...(s.denyWrite.length === 0
      ? []
      : ["(deny file-write*", paths(s.denyWrite) + ")"]),
    ...(s.denyRead.length === 0
      ? []
      : ["(deny file-read*", paths(s.denyRead) + ")"]),
    "(deny network-outbound)",
    LOOPBACK_MARK,
    ...(s.loopbackPorts ?? []).map(
      (port) =>
        `(allow network-outbound (remote ip ${lit(`localhost:${port}`)}))`,
    ),
    // Port, not host: Seatbelt's `remote tcp` names only "*" or "localhost" as the host, so the
    // provider's port is open to EVERY host from inside the sandbox, not only to the provider.
    // That is why a model's provider_url may not use Bayon's own API or GUI port, nor a link-local
    // (metadata) host (models.ts providerUrlProblem), and why frm's --yes says which port it opens.
    ...s.providerPorts.map(
      (port) => `(allow network-outbound (remote tcp ${lit(`*:${port}`)}))`,
    ),
    ...(s.dns
      ? ['(allow network-outbound (literal "/private/var/run/mDNSResponder"))']
      : []),
    "",
  ].join("\n");
}

/** The port a provider's base URL reaches, or undefined when it is not a URL. */
export function portOf(url: string): number | undefined {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    return u.port === ""
      ? u.protocol === "https:"
        ? 443
        : 80
      : Number(u.port);
  } catch {
    return undefined;
  }
}

/** Whether a URL names its host rather than an address, so the resolver must be reachable. */
export function byName(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return (
      !/^[0-9.]+$/.test(host) && !host.startsWith("[") && host !== "localhost"
    );
  } catch {
    return false;
  }
}
