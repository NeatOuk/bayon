// `frm executor add|image|disable|enable` (spec §6.1; plan row ctr-lab).
// `add` registers a container
// executor through @bayon/db/operator (kind container, trust untrusted, egress allowlist) and pins
// its host key by copying the entry from the operator's already-pinned known_hosts
// (`ssh-keygen -F`), never from a scan. `image` builds the runner-neutral image on the docker host
// from every runner's `containerInstall`, records its tag in the row, starts the gateway on it
// with the runners' `egressHosts`, then removes the executor's stopped build containers and older
// images, by label only (unlabelled build leftovers are only reported).
// `disable`/`enable` write `executors.enabled` through the same door: the kill switch admission
// already honours, reversible, and never a decertification.
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import {
  canonicalJson,
  certifyStored,
  DEFAULT_GIT_PATCHED,
  err,
  FrmError,
  GIT_PATCHED_KEY,
  GIT_RELEASE,
  ok,
  pinnedImageId,
  SUPERVISOR_LOCK_FILE,
  systemClock,
  type JsonValue,
  type Result,
  UNTRUSTED_ROLES_KEY,
  UntrustedRoles,
} from "@bayon/core";
import {
  getExecutor,
  getSettings,
  listRunnerCertifications,
  openDb,
  type Db,
  type RunnerCertificationRow,
} from "@bayon/db";
import {
  migrateUp,
  seedConfig,
  setExecutorConfig,
  setExecutorEnabledFromCli,
} from "@bayon/db/operator";
import {
  ContainerExecutor,
  ContainerExecutorConfig,
  EGRESS_HOST,
  EXECUTOR_ID,
  pinKnownHosts,
  SlotCounter,
} from "@bayon/executors";
import { WORK_ROLES } from "@bayon/proto";
import { registrations, type Registration } from "@bayon/runners";
import { z } from "zod";

const DEFAULT_SLOTS = 2;
const DEFAULT_NETWORK = "frm-internal";
const DEFAULT_BASE = ContainerExecutorConfig.shape.base_image.parse(undefined);
const MB = 1_000_000;
/** The roles a session is spawned as (proto WORK_ROLES): what executors.untrusted_roles may list. */
const ROLES: readonly string[] = WORK_ROLES;

export const EXECUTOR_USAGE = [
  "       frm executor add <id> --host <host> --user <user> --identity-ref file:<key> --remote-root <dir>",
  `            [--port 22] [--slots ${DEFAULT_SLOTS}] [--network ${DEFAULT_NETWORK}] [--egress-allow <host,…>]`,
  `            [--base-image ${DEFAULT_BASE}] [--min-free-pct <n>] [--quota-gb <n>]`,
  "            [--known-hosts ~/.ssh/known_hosts]",
  "            [--untrusted-roles <role,…> | --replace-untrusted-roles <role,…>]",
  "       frm executor image <id>",
  "       frm executor disable <id> | frm executor enable <id>",
  "executor add: a container executor (trust untrusted, egress allowlist) in $FRM_DB, else",
  "  $FRM_HOME/foreman.db. Its host key is copied from --known-hosts (ssh-keygen -F), never scanned.",
  `  ${UNTRUSTED_ROLES_KEY} (default investigator) lists the roles admitted only on a trust='untrusted'`,
  "  executor. It is one global operator policy, not this executor's: --untrusted-roles adds its",
  "  roles to it (a union: a narrower list on a later add never drops a role); only",
  "  --replace-untrusted-roles sets it whole. Without either it is left as it is. add prints it",
  `  before and after. Roles: ${ROLES.join(", ")}. Listing reviewer makes every review need this host up.`,
  "executor image: builds the runner-neutral image on the docker host over ssh, records its tag in",
  "  the row, starts the gateway on it and removes the executor's stopped build containers and",
  "  older images, by label only.",
  "executor disable: takes it out of service — admission refuses new spawns on it (disabled), a",
  "  conformance run on it is refused the same way, the Runners screen stops offering",
  "  it, and the disk view leaves it out. Sessions already on it are left running and counted, never",
  "  stopped. Its certifications and probe history are kept: disabling is not decertifying, so",
  "  enable puts it back exactly as it was. Audited as the operator's (via frm).",
].join("\n");

type JsonObject = { readonly [key: string]: JsonValue };

const Json: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(Json),
    z.record(z.string(), Json),
  ]),
);
const JsonRecord = z.record(z.string(), Json);

/** A change to executors.untrusted_roles: `union` adds `roles`, `replace` makes them the list. */
export interface UntrustedRolesChange {
  readonly roles: readonly string[];
  readonly mode: "union" | "replace";
}

export type ExecutorCommand =
  | {
      readonly action: "add";
      readonly id: string;
      /** config_json but `ssh`, validated with it. */
      readonly config: JsonObject;
      /** config_json.ssh; `known_hosts` is added once the key is pinned. */
      readonly ssh: JsonObject;
      readonly target: { readonly host: string; readonly port: number };
      readonly slots: number;
      readonly knownHostsFrom: string;
      /** --untrusted-roles or --replace-untrusted-roles: absent, the setting is not touched. */
      readonly untrustedRoles?: UntrustedRolesChange;
    }
  | { readonly action: "image"; readonly id: string }
  /** `disable` writes executors.enabled 0, `enable` 1; nothing else is touched. */
  | { readonly action: "disable" | "enable"; readonly id: string };

/** The actions that take an id and no flags. */
const FLAGLESS = ["image", "disable", "enable"] as const;
type Flagless = (typeof FLAGLESS)[number];

const isFlagless = (action: string | undefined): action is Flagless =>
  FLAGLESS.includes(action as Flagless);

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

export const EXECUTOR_FLAGS = {
  host: { type: "string" },
  port: { type: "string" },
  user: { type: "string" },
  "identity-ref": { type: "string" },
  "remote-root": { type: "string" },
  slots: { type: "string" },
  network: { type: "string" },
  "egress-allow": { type: "string" },
  "base-image": { type: "string" },
  "min-free-pct": { type: "string" },
  "quota-gb": { type: "string" },
  "known-hosts": { type: "string" },
  "untrusted-roles": { type: "string" },
  "replace-untrusted-roles": { type: "string" },
} as const;
type Flags = {
  readonly [K in keyof typeof EXECUTOR_FLAGS]?: string | undefined;
};

function readFlags(argv: readonly string[]) {
  try {
    return ok(
      parseArgs({
        args: [...argv],
        allowPositionals: true,
        strict: true,
        options: EXECUTOR_FLAGS,
      }),
    );
  } catch (cause) {
    return invalid(cause instanceof Error ? cause.message : "bad arguments");
  }
}

const USAGE_LINE =
  "usage: frm executor add <id> … | frm executor image <id> | frm executor disable|enable <id>";

/** `frm executor <action> <id> [flags]`: the command, or a validation error with the reason. */
export function parseExecutorCli(
  argv: readonly string[],
): Result<ExecutorCommand> {
  const read = readFlags(argv);
  if (!read.ok) return read;
  const { values, positionals } = read.value;
  const [action, id, ...extra] = positionals;
  if (id === undefined || extra.length > 0 || action === undefined) {
    return invalid(USAGE_LINE);
  }
  if (action !== "add" && !isFlagless(action)) return invalid(USAGE_LINE);
  if (!EXECUTOR_ID.test(id)) {
    return invalid(
      `executor id ${JSON.stringify(id)} must match ${EXECUTOR_ID.source}`,
    );
  }
  if (action === "add") return addCommand(id, values);
  const given = Object.keys(values);
  return given.length === 0
    ? ok({ action, id })
    : invalid(
        `frm executor ${action} takes no flags: ${given.map((f) => `--${f}`).join(" ")}`,
      );
}

function addCommand(id: string, v: Flags): Result<ExecutorCommand> {
  const numeric = (flag: string | undefined) =>
    flag === undefined ? {} : { value: Number(flag) };
  const port = numeric(v.port);
  const minFree = numeric(v["min-free-pct"]);
  const quota = numeric(v["quota-gb"]);
  const ssh: JsonObject = {
    host: v.host ?? "",
    user: v.user ?? "",
    identity_ref: v["identity-ref"] ?? "",
    ...("value" in port ? { port: port.value } : {}),
  };
  const base = v["base-image"];
  const config: JsonObject = {
    remote_root: v["remote-root"] ?? "",
    // The image is the base until `frm executor image` builds one.
    image: base ?? DEFAULT_BASE,
    ...(base === undefined ? {} : { base_image: base }),
    network: v.network ?? DEFAULT_NETWORK,
    egress_allow: (v["egress-allow"] ?? "").split(",").filter((h) => h !== ""),
    ...("value" in minFree ? { min_free_pct: minFree.value } : {}),
    ...("value" in quota ? { quota_gb: quota.value } : {}),
  };
  const checked = ContainerExecutorConfig.safeParse({ ...config, ssh });
  if (!checked.success) return invalid(z.prettifyError(checked.error));
  const slots = z.coerce
    .number()
    .int()
    .min(1)
    .max(64)
    .safeParse(v.slots ?? DEFAULT_SLOTS);
  if (!slots.success)
    return invalid(`--slots: ${z.prettifyError(slots.error)}`);
  const roles = untrustedRoles(
    v["untrusted-roles"],
    v["replace-untrusted-roles"],
  );
  if (!roles.ok) return roles;
  return ok({
    action: "add",
    id,
    config,
    ssh,
    target: { host: checked.data.ssh.host, port: checked.data.ssh.port },
    slots: slots.data,
    knownHostsFrom: v["known-hosts"] ?? join(homedir(), ".ssh", "known_hosts"),
    ...(roles.value === null ? {} : { untrustedRoles: roles.value }),
  });
}

/**
 * `--untrusted-roles a,b` (added to the list) or `--replace-untrusted-roles a,b` (the whole list):
 * known role names only, deduplicated. Neither: null, and the setting is not touched. Both: refused.
 */
function untrustedRoles(
  union: string | undefined,
  replace: string | undefined,
): Result<UntrustedRolesChange | null> {
  if (union !== undefined && replace !== undefined) {
    return invalid(
      "--untrusted-roles adds to the list and --replace-untrusted-roles sets it: give one",
    );
  }
  const flag = union ?? replace;
  if (flag === undefined) return ok(null);
  const name =
    union === undefined ? "--replace-untrusted-roles" : "--untrusted-roles";
  const roles = [...new Set(flag.split(",").map((r) => r.trim()))];
  const bad = roles.find((r) => !ROLES.includes(r));
  if (bad !== undefined) {
    return invalid(
      `${name}: ${JSON.stringify(bad)} is not a role (${ROLES.join(", ")})`,
    );
  }
  return ok({ roles, mode: union === undefined ? "replace" : "union" });
}

const ContainerDefaults = z.looseObject({
  containerInstall: z.array(z.string().min(1)).default([]),
  egressHosts: z.array(z.string().regex(EGRESS_HOST)).default([]),
});

/** Every runner's image lines, in runner-id order (a stable render hash), and its egress hosts. */
export function runnerContainerDefaults(regs: readonly Registration[]): Result<{
  readonly installs: readonly string[];
  readonly egressHosts: readonly string[];
}> {
  const parsed = [...regs]
    .toSorted((a, b) => a.runner.id.localeCompare(b.runner.id))
    .map((r) => ({
      id: r.runner.id,
      defaults: ContainerDefaults.safeParse(r.runner.defaults),
    }));
  const bad = parsed.find((p) => !p.defaults.success);
  if (bad !== undefined && !bad.defaults.success) {
    return invalid(`runner ${bad.id}: ${z.prettifyError(bad.defaults.error)}`);
  }
  const good = parsed.flatMap((p) =>
    p.defaults.success ? [p.defaults.data] : [],
  );
  return ok({
    installs: good.flatMap((d) => d.containerInstall),
    egressHosts: [...new Set(good.flatMap((d) => d.egressHosts))].toSorted(),
  });
}

export interface ExecutorIo {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Runs the command against $FRM_DB or $FRM_HOME/foreman.db. Exit 0 done, 1 failed, 2 usage. */
export async function runExecutorCommand(
  cmd: ExecutorCommand,
  io: ExecutorIo,
): Promise<number> {
  const home = io.env["FRM_HOME"];
  if (home === undefined || home === "") {
    io.err("frm executor: set FRM_HOME");
    return 2;
  }
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const opened = await openDb({
    path: io.env["FRM_DB"] ?? join(home, "foreman.db"),
    clock: systemClock,
  });
  if (!opened.ok) {
    io.err(`frm executor: ${opened.error.message}`);
    return 1;
  }
  const db = opened.value;
  try {
    const migrated = await migrateUp(db, {});
    const done = !migrated.ok
      ? migrated
      : cmd.action === "add"
        ? await add(db, home, cmd, io.out)
        : cmd.action === "image"
          ? await image(db, home, cmd.id, io.out)
          : await setEnabled(db, cmd.id, cmd.action === "enable", io.out);
    if (done.ok) return 0;
    io.err(`frm executor ${cmd.action}: ${done.error.message}`);
    return 1;
  } finally {
    await db.close();
  }
}

async function add(
  db: Db,
  home: string,
  cmd: Extract<ExecutorCommand, { action: "add" }>,
  out: (line: string) => void,
): Promise<Result<void>> {
  const existing = await getExecutor(db, cmd.id);
  if (existing.ok) {
    return err({
      class: "conflict",
      message: `executor ${cmd.id} exists; its host key is not re-pinned`,
      retryable: false,
    });
  }
  if (existing.error.class !== "not_found") return existing;
  const knownHosts = join(home, "executors", cmd.id, "known_hosts");
  const pinned = pinKnownHosts({
    from: cmd.knownHostsFrom,
    host: cmd.target.host,
    port: cmd.target.port,
    to: knownHosts,
  });
  if (!pinned.ok) return pinned;
  const config = {
    ...cmd.config,
    ssh: { ...cmd.ssh, known_hosts: knownHosts },
  };
  const seeded = await seedConfig(db, {
    executors: [
      {
        id: cmd.id,
        kind: "container",
        config_json: canonicalJson(config),
        slots: cmd.slots,
        egress_policy: "allowlist",
        trust: "untrusted",
      },
    ],
  });
  if (!seeded.ok) return seeded;
  const trust = await applyUntrustedRoles(db, cmd.untrustedRoles);
  if (!trust.ok) return trust;
  out(
    `executor ${cmd.id}: container on ${cmd.target.host}, ${cmd.slots} slots, trust untrusted, egress allowlist`,
  );
  out(
    `host key  ${pinned.value} entr${pinned.value === 1 ? "y" : "ies"} copied from ${cmd.knownHostsFrom} to ${knownHosts}`,
  );
  out(`trust     ${UNTRUSTED_ROLES_KEY}: ${trust.value}`);
  out(`next      frm executor image ${cmd.id}`);
  return ok(undefined);
}

/**
 * `frm executor disable|enable <id>`. The write is one column through the operator
 * door; everything the operator needs to know afterwards is said here: what changed, how many live
 * sessions were left alone (a disable ends none), and that the certifications stayed.
 */
async function setEnabled(
  db: Db,
  id: string,
  enabled: boolean,
  out: (line: string) => void,
): Promise<Result<void>> {
  const set = await setExecutorEnabledFromCli(db, id, enabled);
  if (!set.ok) return set;
  const { changed, live } = set.value;
  const state = enabled ? "enabled" : "disabled";
  out(
    `executor ${id}: ${changed ? state : `already ${state}; nothing written`}`,
  );
  out(
    enabled
      ? "spawns    admission may place new sessions here again"
      : "spawns    admission refuses new sessions here (disabled); its certifications and probe " +
          "history are kept",
  );
  out(
    `sessions  ${live} live on it, left running${live > 0 && !enabled ? "; they finish where they are" : ""}`,
  );
  if (changed)
    out(`audited   executor.${enabled ? "enable" : "disable"} via frm`);
  return ok(undefined);
}

const listed = (roles: readonly string[]): string =>
  roles.length === 0 ? "(none)" : roles.join(", ");

/**
 * Rule 4's roles are one global operator policy, changed only on a flag: a
 * union by default, so a later add with a narrower list never drops a role (reviewer, say); the
 * whole list only on --replace-untrusted-roles. Says what it was and what it is, previous → new,
 * or that nothing changed. A config write, through @bayon/db/operator.
 */
/**
 * The submodule floor (§3.6) `frm executor image` checks a built image's git against:
 * `workspace.git_patched` when it is set, else core's default. Read here rather than in the
 * executor so a build and a spawn judge by the same list.
 */
async function gitPatched(db: Db): Promise<Result<readonly string[]>> {
  const rows = await getSettings(db, [GIT_PATCHED_KEY]);
  if (!rows.ok) return rows;
  const raw = rows.value.get(GIT_PATCHED_KEY);
  if (raw === undefined) return ok(DEFAULT_GIT_PATCHED);
  const parsed = z.array(z.string().regex(GIT_RELEASE)).min(1).safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : invalid(`${GIT_PATCHED_KEY} is not a list of upstream git releases`);
}

async function applyUntrustedRoles(
  db: Db,
  change: UntrustedRolesChange | undefined,
): Promise<Result<string>> {
  const rows = await getSettings(db, [UNTRUSTED_ROLES_KEY]);
  if (!rows.ok) return rows;
  const current = UntrustedRoles.safeParse(
    rows.value.get(UNTRUSTED_ROLES_KEY) ?? [],
  );
  if (!current.success) {
    return invalid(`${UNTRUSTED_ROLES_KEY} is not a list of roles`);
  }
  const before = current.data;
  if (change === undefined) {
    return ok(`${listed(before)} (unchanged; --untrusted-roles adds to it)`);
  }
  const after =
    change.mode === "union"
      ? [...new Set([...before, ...change.roles])]
      : [...change.roles];
  const saved = await seedConfig(db, {
    settings: { [UNTRUSTED_ROLES_KEY]: after },
  });
  if (!saved.ok) return saved;
  return ok(`${listed(before)} → ${listed(after)}`);
}

const failure = (e: unknown): Result<never> => {
  const known = FrmError.safeParse(e);
  return err(
    known.success
      ? known.data
      : {
          class: "internal",
          message: e instanceof Error ? e.message : String(e),
          retryable: false,
        },
  );
};

function rawConfig(text: string): Result<JsonObject> {
  try {
    const parsed = JsonRecord.safeParse(JSON.parse(text));
    return parsed.success
      ? ok(parsed.data)
      : invalid("config_json is not an object");
  } catch {
    return invalid("config_json is not JSON");
  }
}

/**
 * Which of `rows`' live certifications for this executor the image lapses. The
 * supervisor's next
 * health pass is what actually decertifies them — it re-reads the image's id and compares it with
 * what each result pinned — so this only says, before the operator walks away, which runners are
 * about to need re-certifying. A pair pinned to the same id survives.
 *
 * A pair that pins no image is named too. It is not one that merely survives an
 * image change: on a container the image id is the only pin there is, so a pair without one is not
 * certified for unattended work at all and the next boot decertifies it. Every container
 * certification stored before an earlier change is one of those, and this command — run right after a base
 * image change — is where the operator would otherwise read "none lapse on this image".
 */
export function lapsingOf(
  rows: readonly RunnerCertificationRow[],
  id: string,
  imageId: string,
): string {
  const lapsed: string[] = [];
  const unpinned: string[] = [];
  for (const row of rows) {
    if (row.executor_id !== id || row.decertified_at !== null) continue;
    const result = certifyStored(row.result_json);
    if (!result.ok) continue;
    const pinned = pinnedImageId(result.value);
    if (pinned === null) unpinned.push(row.runner_id);
    else if (pinned !== imageId) lapsed.push(row.runner_id);
  }
  const said = [
    ...(lapsed.length === 0
      ? []
      : [`${lapsed.join(", ")} lapses on the next health pass`]),
    ...(unpinned.length === 0
      ? []
      : [
          `${unpinned.join(", ")} pins no image, so it is not certified for unattended work`,
        ]),
  ];
  return said.length === 0
    ? "none lapse on this image"
    : `${said.join("; ")}; re-run \`frm runner conformance\``;
}

async function lapsing(db: Db, id: string, imageId: string): Promise<string> {
  const rows = await listRunnerCertifications(db);
  return rows.ok
    ? lapsingOf(rows.value, id, imageId)
    : `cannot be read: ${rows.error.message}`;
}

/**
 * What to say when a supervisor may be running on this FRM_HOME; null when none is. It
 * builds its executors at boot and holds the old image tag until its next health pass re-reads the
 * row, so the tag this command writes is not live everywhere the moment it lands. Said, not
 * refused: the pass adopts it on its own, which is what the incident wanted. The lock's presence
 * is the same evidence `frm backup restore` treats as a supervisor — a crashed one leaves it too,
 * hence "may".
 */
export function supervisorNote(home: string): string | null {
  return existsSync(join(home, SUPERVISOR_LOCK_FILE))
    ? "note      a supervisor may be running on this FRM_HOME; it adopts the new image and the " +
        "row's egress_allow on its next health pass, and until then still places sessions on the " +
        "old one. A change to what the *runners* allow needs a supervisor restart, not a rebuild"
    : null;
}

async function image(
  db: Db,
  home: string,
  id: string,
  out: (line: string) => void,
): Promise<Result<void>> {
  const note = supervisorNote(home);
  if (note !== null) out(note);
  const row = await getExecutor(db, id);
  if (!row.ok) return row;
  if (row.value.kind !== "container") {
    return invalid(
      `executor ${id} is ${row.value.kind}, not a container executor`,
    );
  }
  const raw = rawConfig(row.value.config_json);
  if (!raw.ok) return raw;
  const config = ContainerExecutorConfig.safeParse(raw.value);
  if (!config.success) return invalid(z.prettifyError(config.error));
  const runners = runnerContainerDefaults(registrations());
  if (!runners.ok) return runners;
  let executor: ContainerExecutor;
  try {
    executor = new ContainerExecutor({
      id,
      slots: new SlotCounter(row.value.slots),
      frmHome: home,
      config: config.data,
      egressHosts: runners.value.egressHosts,
    });
  } catch (e) {
    return failure(e);
  }
  try {
    out(
      `building  on ${config.data.ssh.host} from ${config.data.base_image}, ${runners.value.installs.length} runner install line(s)`,
    );
    const patched = await gitPatched(db);
    if (!patched.ok) return patched;
    const built = await executor.buildImage(
      runners.value.installs,
      patched.value,
    );
    out(
      `image     ${built.tag}  ${built.id}  ${Math.round(built.sizeBytes / MB)} MB${built.built ? "" : "  (already built)"}`,
    );
    out(`git       ${built.gitVersion}  (clears the submodule floor)`);
    const saved = await setExecutorConfig(db, id, {
      ...raw.value,
      image: built.tag,
    });
    if (!saved.ok) return saved;
    out(`certs     ${await lapsing(db, id, built.id)}`);
    await executor.ensureGateway(built.tag);
    const { proxyUrl } = executor.gatewayUrls();
    out(
      proxyUrl === undefined
        ? "gateway   none (network none)"
        : `gateway   ${proxyUrl} on ${config.data.network}; runner egress ${runners.value.egressHosts.join(", ") || "none"}`,
    );
    // A labelled build container left by an interrupted build holds its image: it goes first.
    const leftovers = await executor.pruneBuildLeftovers();
    out(
      `leftovers ${leftovers.removed.length} stopped build container(s) removed${leftovers.kept.length > 0 ? `; ${leftovers.kept.length} could not be` : ""}`,
    );
    const pruned = await executor.pruneImages(built.id);
    out(
      `pruned    ${pruned.removed.length} older image(s)${pruned.kept.length > 0 ? `; kept ${pruned.kept.length} still in use` : ""}`,
    );
    return ok(undefined);
  } catch (e) {
    return failure(e);
  } finally {
    await executor.close();
  }
}
