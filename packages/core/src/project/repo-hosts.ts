import { z } from "zod";
import { remoteHost } from "../delivery/remote.js";

// Which hosts a project's repo may be read from (security review, M2). A repo URL makes
// the supervisor connect somewhere from this machine, so the New project form — which a LAN page
// can reach with the operator's bearer — must not turn it into a probe of the host's own network:
//
// - link-local and cloud metadata addresses (169.254.0.0/16, fe80::/10, the metadata names) are
//   refused always;
// - loopback and private addresses (127/8, 10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7, ::1,
//   `localhost`) are refused unless the operator lists the host in `projects.private_repo_hosts`, a
//   shell-only security control (a self-hosted git server on the LAN is legitimate, opted into).
//
// Pure: the supervisor passes what DNS resolved the host to, the API only the literal host. Git
// resolves the name again when it connects, so a name that resolves differently a moment later (DNS
// rebinding) is not caught by the resolution check — the literal check and the protocol allow-list
// are what always hold.

export const PRIVATE_REPO_HOSTS_KEY = "projects.private_repo_hosts";

/** Host names or IP literals, lower case, exactly as a repo URL names them. `[]` is none. */
export const PrivateRepoHosts = z.array(
  z
    .string()
    .regex(
      /^[a-z0-9._:-]{1,253}$/,
      "a host name or IP address in lower case, no scheme, port or path",
    ),
);
export type PrivateRepoHosts = z.infer<typeof PrivateRepoHosts>;

export type AddressKind = "public" | "private" | "loopback" | "link_local";

/** Names that are a cloud's instance metadata service, whatever they resolve to. */
const METADATA_HOSTS: ReadonlySet<string> = new Set([
  "metadata",
  "metadata.google.internal",
  "metadata.azure.com",
  "instance-data",
  "instance-data.ec2.internal",
  "fd00:ec2::254",
]);

function ipv4Kind(host: string): AddressKind | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (m === null) return null;
  const [a = 0, b = 0] = m.slice(1, 3).map(Number);
  if (m.slice(1).some((part) => Number(part) > 255)) return null;
  if (a === 169 && b === 254) return "link_local";
  if (a === 127 || a === 0) return "loopback";
  if (a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31))
    return "private";
  if (a === 100 && b >= 64 && b <= 127) return "private";
  return "public";
}

function ipv6Kind(host: string): AddressKind | null {
  if (!host.includes(":")) return null;
  const h = host.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  if (mapped?.[1] !== undefined) return ipv4Kind(mapped[1]);
  if (h === "::1" || h === "::") return "loopback";
  if (/^fe[89ab]/.test(h)) return "link_local";
  if (/^f[cd]/.test(h)) return "private";
  return "public";
}

/** What kind of address `host` is: an IP literal by its range, `localhost` loopback, else public. */
export function addressKind(host: string): AddressKind {
  const h = host.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return "loopback";
  return ipv4Kind(h) ?? ipv6Kind(h) ?? "public";
}

/** `url`'s host as the policy judges it: lower case, IPv6 without its brackets; null for none. */
export const repoUrlHost = (url: string): string | null =>
  remoteHost(url)?.replace(/^\[|\]$/g, "") ?? null;

/**
 * Why the repo at `url` may not be read from this machine, in plain words, or null. `addresses`:
 * what its host resolved to (none: the literal host alone is judged). `allowed`:
 * `projects.private_repo_hosts`.
 */
export function repoHostProblem(
  url: string,
  addresses: readonly string[],
  allowed: readonly string[],
): string | null {
  const host = repoUrlHost(url);
  if (host === null) return null;
  const kinds = [host, ...addresses].map(addressKind);
  if (
    METADATA_HOSTS.has(host) ||
    addresses.some((a) => METADATA_HOSTS.has(a.toLowerCase())) ||
    kinds.includes("link_local")
  ) {
    return `Bayon never reads a repository from ${host}: it is a link-local or cloud metadata address.`;
  }
  const inside = kinds.find((k) => k === "loopback" || k === "private");
  if (inside === undefined) return null;
  const listed = [host, ...addresses].some((h) =>
    allowed.includes(h.toLowerCase()),
  );
  if (listed) return null;
  const what =
    inside === "loopback" ? "this machine itself" : "a private network";
  return `${host} is on ${what}, and Bayon reads a repository there only when you allow its host. If it is your own git server, add it from a terminal: pnpm frm settings set ${PRIVATE_REPO_HOSTS_KEY} ${[...allowed, host].join(",")} --yes`;
}
