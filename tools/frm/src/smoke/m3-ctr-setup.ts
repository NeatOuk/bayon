import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { err, ok, type Result } from "@bayon/core";
import { getExecutor, type Db } from "@bayon/db";
import { setExecutorConfig } from "@bayon/db/operator";
import { ContainerExecutorConfig } from "@bayon/executors";
import { CTR_IMAGE_TIMEOUT_MS } from "./budget.js";
import { refuse, type Harness } from "./harness.js";
import { cleanProblems } from "./m3-ctr-assertions.js";
import { M3C } from "./m3-ctr-config.js";
import {
  SSH_TIMEOUT_MS,
  cleanupByLabel,
  frmCli,
  leftovers,
  shipStandIn,
  unlabelled,
  type CtrRun,
} from "./m3-ctr-host.js";
import { standInEnv, type StandIn } from "./m3-stand-in.js";

// The M3 container run's setup (before the supervisor boots, which loads executors from their
// rows): the executor registered and imaged by the operator's own CLI as // gated run does it, the reviewer's stand-in shipped into its mirror directory and put first on
// its containers' PATH; and teardown's cleanup of everything this run made, by label only.

export interface CtrSetup {
  readonly run: CtrRun;
  readonly standIn: StandIn;
  /** tools/frm/dist/main.js: the operator's CLI, built. */
  readonly frmEntry: string;
  /** The operator's already-pinned known_hosts the executor's host key is copied from. */
  readonly knownHostsFrom?: string;
}

const out = (h: Harness, text: string): void => {
  for (const line of text.split("\n").filter((l) => l.trim() !== ""))
    h.io.out(`      ${line.trim()}`);
};

/** Registers the executor; from here on teardown removes whatever this run made, by label. */
async function register(h: Harness, s: CtrSetup): Promise<void> {
  const { run } = s;
  const added = await h.step(
    `frm executor add ${run.executorId} (--untrusted-roles ${M3C.untrustedRoles})`,
    async () =>
      frmCli(
        s.frmEntry,
        h.home,
        [
          "executor",
          "add",
          run.executorId,
          "--host",
          run.target.host,
          "--user",
          run.target.user,
          "--identity-ref",
          `file:${run.target.key}`,
          "--remote-root",
          run.root,
          "--network",
          run.network,
          "--egress-allow",
          M3C.egressAllowed,
          "--known-hosts",
          s.knownHostsFrom ?? join(homedir(), ".ssh", "known_hosts"),
          "--untrusted-roles",
          M3C.untrustedRoles,
        ],
        SSH_TIMEOUT_MS,
      ),
  );
  out(h, added);
  // From here on the host may hold this run's objects: teardown cleans them even if a step fails.
  const listing = h.step(
    "the docker host's unlabelled containers, before (listed, never touched)",
    async () => unlabelled(run),
  );
  h.defer("the docker host, cleaned by label", async () =>
    cleanHost(h, run, await listing.catch(() => undefined)),
  );
  const before = await listing;
  h.io.out(`      ${before.length} unlabelled container(s)`);
}

/** Teardown: this run's objects by label and its root; then the host must be as it was. */
async function cleanHost(
  h: Harness,
  run: CtrRun,
  before: readonly string[] | undefined,
): Promise<string[]> {
  const cleaned = await cleanupByLabel(run);
  const left = await leftovers(run);
  const after = await unlabelled(run);
  const ssh = leftoverSsh(run);
  const problems = [
    ...(cleaned.ok ? [] : [`cleanup: ${cleaned.error.message}`]),
    ...(left.ok ? [] : [`leftovers: ${left.error.message}`]),
    ...(after.ok ? [] : [`unlabelled after: ${after.error.message}`]),
    ...(before === undefined
      ? ["unlabelled containers never listed before: unchanged is unproven"]
      : []),
    ...(left.ok && after.ok
      ? cleanProblems(left.value, before ?? after.value, after.value)
      : []),
    ...ssh,
  ];
  const counts = left.ok
    ? Object.entries(left.value)
        .map(([k, v]) => `${k} ${v}`)
        .join(", ")
    : "unknown";
  h.io.out(
    `host  ${run.executorId} after teardown: ${counts}; unlabelled containers ${before?.length ?? "?"} before, ${after.ok ? after.value.length : "?"} after${problems.length === 0 ? ", the same ones" : ""}`,
  );
  return problems;
}

/** Local ssh processes still holding this executor's pinned key (a master, a tunnel): killed. */
function leftoverSsh(run: CtrRun): string[] {
  const pids = sshPids(run.knownHosts);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  return pids.length === 0
    ? []
    : [
        `${pids.length} ssh process(es) of ${run.executorId} outlived the supervisor (killed)`,
      ];
}

/** Local processes whose command line names `knownHosts`; pgrep exits 1 when none does. */
function sshPids(knownHosts: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", knownHosts], { encoding: "utf8" })
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map(Number);
  } catch {
    return [];
  }
}

/** The stand-in into the executor's mirror directory, and env_path with its shim first. */
async function standInOnHost(h: Harness, db: Db, s: CtrSetup): Promise<void> {
  await h.step(
    "the reviewer's stand-in shipped into the executor's mirror; its containers' PATH puts it first",
    async () => {
      const stubPath = s.standIn.cli.argv[1];
      if (stubPath === undefined)
        return err(refuse("the stand-in names no script"));
      const dir = await shipStandIn(
        s.run,
        { file: basename(stubPath), text: readFileSync(stubPath, "utf8") },
        s.standIn.cli.program,
      );
      if (!dir.ok) return dir;
      const row = await getExecutor(db, s.run.executorId);
      if (!row.ok) return row;
      const raw = JSON.parse(row.value.config_json) as Record<string, unknown>;
      const parsed = ContainerExecutorConfig.safeParse(raw);
      if (!parsed.success)
        return err(refuse(`the executor's config: ${parsed.error.message}`));
      return setExecutorConfig(db, s.run.executorId, {
        ...(raw as Record<string, string>),
        env_path: `${dir.value}:${parsed.data.env_path}`,
      });
    },
  );
}

/**
 * setUp's hook for the container run: register and image the executor, ship the stand-in, and
 * give the supervisor its env (the stand-in's secret is this run's canary). Returns that env.
 */
export async function ctrBeforeSupervisor(
  h: Harness,
  db: Db,
  s: CtrSetup,
): Promise<Readonly<Record<string, string>>> {
  await register(h, s);
  const imaged = await h.step(
    `frm executor image ${s.run.executorId}: the image built on the host, its gateway started`,
    async () =>
      frmCli(
        s.frmEntry,
        h.home,
        ["executor", "image", s.run.executorId],
        CTR_IMAGE_TIMEOUT_MS,
      ),
  );
  out(h, imaged);
  await standInOnHost(h, db, s);
  return h.step(
    "the supervisor's env: the stand-in's secrets are this run's canary",
    async (): Promise<Result<Record<string, string>>> => {
      const env = standInEnv(
        h.home,
        s.standIn,
        h.io.env["PATH"] ?? "",
        s.run.canary,
      );
      return env.ok ? ok(env.value) : env;
    },
  );
}
