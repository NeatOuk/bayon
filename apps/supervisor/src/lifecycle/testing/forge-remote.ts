// A stand-in for a private https repository on a forge: a `git` first on PATH that, for
// a clone or fetch whose remote is `https://github.com/…`, demands a credential exactly as such a
// remote does — it asks git's own configured credential helpers (`git credential fill`, under the
// same flags and environment the real call got) and refuses unless they answer with `token`. Once
// answered, it serves `source` in the forge's place. Every other call is the real git. No network
// is touched. Each call's argv is logged, with only whether the token variable was set — the log
// is what a test reads to prove the token never reached argv.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GIT_TOKEN_ENV } from "@bayon/executors";

export const FORGE_URL = "https://github.com/acme/private.git";

export interface ForgeCall {
  readonly args: readonly string[];
  /** Whether the token's variable was in git's environment (never its value). */
  readonly tokenInEnv: boolean;
}

export interface StandInForge {
  /** PATH with the stand-in first. */
  readonly path: string;
  readonly calls: () => ForgeCall[];
}

export function standInForge(o: {
  readonly dir: string;
  readonly source: string;
  readonly token: string;
  readonly basePath?: string;
}): StandInForge {
  const bin = join(o.dir, "forge-bin");
  mkdirSync(bin, { recursive: true });
  const log = join(bin, "calls.log");
  const realGit = execFileSync("sh", ["-c", "command -v git"], {
    encoding: "utf8",
  }).trim();
  const script = `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const REAL = ${JSON.stringify(realGit)};
const SOURCE = ${JSON.stringify(o.source)};
const TOKEN = ${JSON.stringify(o.token)};
const HOST = "https://github.com/";
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({
  args,
  tokenInEnv: process.env[${JSON.stringify(GIT_TOKEN_ENV)}] !== undefined,
}) + "\\n");
let i = 0;
while (i < args.length) {
  const a = args[i];
  if (a === "-C" || a === "-c") i += 2;
  else if (a.startsWith("--") && a.includes("=")) i += 1;
  else break;
}
const sub = args[i];
const pre = args.slice(0, i);
const real = (argv) => spawnSync(REAL, argv, { stdio: "inherit" }).status ?? 1;
let forge = false;
if (sub === "clone") forge = args.slice(i).some((a) => a.startsWith(HOST));
if (sub === "fetch") {
  const at = pre.indexOf("-C");
  const url = spawnSync(REAL, ["-C", at >= 0 ? pre[at + 1] : ".", "config", "remote.origin.url"], {
    encoding: "utf8",
  });
  forge = (url.stdout || "").trim().startsWith(HOST);
}
if (!forge) process.exit(real(args));
const fill = spawnSync(REAL, [...pre, "credential", "fill"], {
  input: "protocol=https\\nhost=github.com\\n\\n",
  encoding: "utf8",
});
const password = /^password=(.*)$/m.exec(fill.stdout || "");
if (fill.status !== 0 || password === null || password[1] !== TOKEN) {
  process.stderr.write(fill.stderr || "remote: Invalid username or token.\\nfatal: Authentication failed for 'https://github.com/'\\n");
  process.exit(128);
}
process.exit(real(args.map((a, k) =>
  k > i && (a.startsWith(HOST) || (sub === "fetch" && a === "origin")) ? SOURCE : a,
)));
`;
  writeFileSync(join(bin, "git"), script, { mode: 0o755 });
  return {
    path: `${bin}:${o.basePath ?? process.env["PATH"] ?? "/usr/bin:/bin"}`,
    calls: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .filter((l) => l !== "")
            .map((l) => JSON.parse(l) as ForgeCall)
        : [],
  };
}
