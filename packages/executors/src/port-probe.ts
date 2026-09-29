// Whether a TCP port is free on this machine: what `frm init` picks a second install's
// ports with, and what the GUI's dev server checks before it listens. A port counts as taken when
// any of the two wildcards, 127.0.0.1 or ::1 refuses it: with SO_REUSEADDR (which Node sets) the kernel
// lets a server bind localhost:5173 while another holds *:5173, and that shadowing is the bug.
import { createServer } from "node:net";

/**
 * The addresses probed: the IPv4 wildcard on its own (a dual-stack `::` bind does not collide with
 * a server on 0.0.0.0 on macOS), the default dual-stack wildcard, and both loopbacks.
 */
const HOSTS: readonly (string | undefined)[] = [
  "0.0.0.0",
  undefined,
  "127.0.0.1",
  "::1",
];

/** Codes that mean "this host has no such address", not "the port is taken". */
const NO_ADDRESS = new Set(["EADDRNOTAVAIL", "EAFNOSUPPORT"]);

function freeOn(port: number, host: string | undefined): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", (e: NodeJS.ErrnoException) =>
      resolve(e.code !== undefined && NO_ADDRESS.has(e.code)),
    );
    server.listen({ port, host, exclusive: true }, () =>
      server.close(() => resolve(true)),
    );
  });
}

/** True when no server on this machine holds `port` on the wildcard or on loopback. */
export async function portFree(port: number): Promise<boolean> {
  for (const host of HOSTS) {
    if (!(await freeOn(port, host))) return false;
  }
  return true;
}
