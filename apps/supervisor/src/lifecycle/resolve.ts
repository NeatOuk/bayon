// Step 0 of the spawn pipeline: reads only. A failure fails the command and leaves no session row.
import {
  admissionRefused,
  err,
  hashConfig,
  loadRunClasses,
  ModelTier,
  ok,
  sha256Hex,
  stepOfRunClass,
  type Result,
  type RunClass,
} from "@bayon/core";
import {
  bindingModelOn,
  getAgent,
  getExecutor,
  getMission,
  getProfile,
  getRunner,
  getSession,
  getWorkspace,
  listRunClasses,
  type AgentRow,
  type StepRef,
  type ModelRow,
  type ProfileRow,
  type RunnerRow,
} from "@bayon/db";
import { createSession } from "@bayon/db/supervisor";
import type { RunnerAdapter } from "@bayon/runners";
import { pinnedRuleset, sessionCompression } from "./compression.js";
import type { Ctx } from "./context.js";
import { frmError } from "./errors.js";
import { SESSION_ID, sessionPathsOn, type SessionPaths } from "./paths.js";
import type { SessionSpawnPayload } from "./payloads.js";
import {
  mintToken,
  sessionToolset,
  type McpToken,
  type SessionToolset,
} from "./mcp.js";
import {
  ENV_NAME,
  RESERVED_ENV,
  parseConfig,
  type SessionConfig,
} from "./profile.js";
import {
  resolveSuccessor,
  successorPlace,
  type Successor,
} from "./successor.js";

export interface Resolved {
  readonly sessionId: string;
  readonly payload: SessionSpawnPayload;
  readonly agent: AgentRow;
  readonly runner: RunnerRow;
  readonly adapter: RunnerAdapter;
  readonly config: SessionConfig;
  /** The profile the session runs: the agent's, or InternalSpawn's (a reviewer's). */
  readonly profileId: string;
  readonly configHash: string;
  readonly executorId: string;
  readonly workspaceId: string | null;
  readonly runClass: RunClass;
  /** The session tier's active model; null is admission's `no_model`. */
  readonly model: ModelRow | null;
  /** The session's tier: its role binding's, else its project's for its step, else its profile's. */
  readonly tier: string;
  /**
   * Its model calls go through the context proxy (spec M12): decided once, here, and read
   * by admission (which certificate), the row (`context_ruleset`) and the spawn (the spec).
   */
  readonly compression: boolean;
  readonly missionHash: string | null;
  /** The mission's rendered text, which run 1's prompt carries; its sha256 is `missionHash`. */
  readonly missionText: string | null;
  readonly paths: SessionPaths;
  /** Minted here: the plaintext lives in memory only; the row gets its hash. */
  readonly mcpToken: McpToken;
  /** The mounted tools and toolset_hash, fixed at resolve. */
  readonly toolset: SessionToolset;
  /** The hand-off this session takes over, with its predecessor's worktree (M2-c). */
  readonly successor: Successor | null;
  /** A detached worktree at a pinned commit instead of a fresh branch (M3-h's reviewer). */
  readonly at: PinnedCheckout | null;
  /** The gate this session reviews, and the bound runner a fallback replaced (M3-h). */
  readonly gate: {
    readonly id: string;
    readonly fallbackFrom: string | null;
  } | null;
}

const invalid = (message: string): Result<never> =>
  err(frmError("validation", message));

/** A commit to check out detached, and the base it is reviewed against. */
export interface PinnedCheckout {
  readonly sha: string;
  readonly baseSha: string;
  /** The gate's repo: its one worktree; absent means the primary. */
  readonly repoId?: string;
}

/**
 * Where the session works: the agent's workspace (today's path), none, a predecessor's, or the
 * agent's workspace checked out detached at a pinned commit (a gate's reviewer).
 */
export type InternalWorkspace =
  | "agent"
  | "none"
  | { readonly inherit: { readonly worktreeId: string } }
  | { readonly at: PinnedCheckout };

/**
 * InternalSpawn's workspace: "none" is no worktree even if the agent has a workspace;
 * `{inherit}` is the worktree of the payload's hand-off, checked to be that one (M2-c); `{at}` a
 * detached worktree at a commit (M3-h). `gate` and `profileId` are a reviewer's.
 */
export interface ResolveOptions {
  readonly workspace?: InternalWorkspace;
  readonly gate?: { readonly id: string; readonly fallbackFrom: string | null };
  readonly profileId?: string;
  /** The binding whose model_tier decides the model; default the payload's role. */
  readonly bindingRole?: string;
  readonly env?: Readonly<Record<string, string>>;
}

/**
 * The profile's env with this spawn's own added (H1, amended by), **validated
 * and hashed**.
 *
 * Validated: `parseConfig` holds a profile's env to the `EnvName` shape and refuses `RESERVED_ENV`,
 * and neither check reached here. `buildEnv` writes the reserved names and the secrets after
 * `config.env`, so a colliding name was *silently dropped* rather than refused — the wrong default
 * for a field any job may use. A bad name is now `validation`, before the session row and before
 * any spend.
 *
 * Hashed: `spawn_env` joins `config.input`, so `config_hash` (§8.1) distinguishes two runs of the
 * same profile that work on different things — two parity runs on different commits hashed
 * identically before. It also makes `adoptSpec` refuse: it rebuilds the child env from the profile
 * alone, so it cannot reproduce this hash, and the check that exists to catch a config it cannot
 * rebuild now does. Only a spawn that passes env is hashed differently: with none, `input` is
 * exactly what it was.
 */
export function withSpawnEnv(
  profileId: string,
  config: SessionConfig,
  env: Readonly<Record<string, string>> | undefined,
): Result<SessionConfig> {
  if (env === undefined) return ok(config);
  const names = Object.keys(env).toSorted();
  const reserved = names.filter((name) => RESERVED_ENV.has(name));
  const malformed = names.filter((name) => !ENV_NAME.test(name));
  // A name the profile's secrets already claim would be overwritten by the secret store's value in
  // buildEnv — the same silent loss, by another route.
  const secrets = new Set([
    ...config.secretNames,
    ...config.secretAnyOf.flat(),
  ]);
  const taken = names.filter((name) => secrets.has(name));
  const bad = [
    ...(malformed.length > 0
      ? [`${malformed.join(", ")} is not an environment variable name`]
      : []),
    ...(reserved.length > 0
      ? [`${reserved.join(", ")} is owned by the supervisor`]
      : []),
    ...(taken.length > 0
      ? [`${taken.join(", ")} is a secret name of profile ${profileId}`]
      : []),
  ];
  if (bad.length > 0) {
    return invalid(`this spawn's own environment: ${bad.join("; ")}`);
  }
  const input = config.input;
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return invalid(`profile ${profileId}'s config input is not an object`);
  }
  return ok({
    ...config,
    env: { ...config.env, ...env },
    input: { ...input, spawn_env: { ...env } },
  });
}

const GIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

function pinnedOf(
  workspace: InternalWorkspace | undefined,
): Result<PinnedCheckout | null> {
  if (typeof workspace !== "object" || !("at" in workspace)) return ok(null);
  const { sha, baseSha, repoId } = workspace.at;
  if (repoId !== undefined && repoId.trim() === "") {
    return invalid("a pinned checkout's repo id is empty");
  }
  return GIT_SHA.test(sha) && GIT_SHA.test(baseSha)
    ? ok(workspace.at)
    : invalid("a pinned checkout needs full git object ids");
}

export async function resolveSpawn(
  ctx: Ctx,
  p: SessionSpawnPayload,
  o: ResolveOptions = {},
): Promise<Result<Resolved>> {
  if (!SESSION_ID.test(p.session_id)) {
    return invalid(
      `session id ${JSON.stringify(p.session_id)} is not a safe token`,
    );
  }
  const agent = await getAgent(ctx.db, p.agent_id);
  if (!agent.ok) return agent;
  const runner = await usableRunner(ctx, p.runner_id ?? agent.value.runner_id);
  if (!runner.ok) return runner;
  const profile = await agentProfile(
    ctx,
    agent.value,
    runner.value.row.id,
    o.profileId,
  );
  if (!profile.ok) return profile;
  const at = pinnedOf(o.workspace);
  if (!at.ok) return at;
  const parsed = parseConfig(profile.value, runner.value.row, p.role);
  if (!parsed.ok) return parsed;
  // Before the toolset, the pre-flight and the row: a bad name refuses the spawn, never reaches a
  // child's env, and never costs a turn.
  const config = withSpawnEnv(profile.value.id, parsed.value, o.env);
  if (!config.ok) return config;
  const toolset = await sessionToolset(
    p.role,
    config.value,
    runner.value.adapter,
  );
  if (!toolset.ok) return toolset;
  const successor = await resolveSuccessor(ctx, p, o.workspace);
  if (!successor.ok) return successor;
  const place = await placeOf(ctx, p, agent.value, o, successor.value);
  if (!place.ok) return place;
  const { workspaceId, executorId } = place.value;
  const runClass = await findRunClass(ctx, p.run_class);
  if (!runClass.ok) return runClass;
  const model = await tierModel(
    ctx,
    o.bindingRole ?? p.role,
    runner.value.row.id,
    profile.value,
    {
      workspaceId: spawnProject({
        payload: p,
        workspaceId,
        agent: agent.value,
      }),
      step: stepOfRunClass(runClass.value.name),
    },
  );
  if (!model.ok) return model;
  const compression = await sessionCompression({
    db: ctx.db,
    adapter: runner.value.adapter,
    executorId,
    workspaceId: spawnProject({ payload: p, workspaceId, agent: agent.value }),
    worktree: workspaceId !== null,
    role: p.role,
  });
  if (!compression.ok) return compression;
  const mission = await missionOf(ctx, agent.value);
  if (!mission.ok) return mission;
  return ok({
    sessionId: p.session_id,
    payload: p,
    agent: agent.value,
    runner: runner.value.row,
    adapter: runner.value.adapter,
    config: config.value,
    profileId: profile.value.id,
    configHash: await hashConfig(config.value.input),
    executorId,
    workspaceId,
    runClass: runClass.value,
    model: model.value.model,
    tier: model.value.tier,
    compression: compression.value,
    missionHash: mission.value.hash,
    missionText: mission.value.text,
    // Its executor places the root, home and tmp when they are not ours (a container).
    paths: sessionPathsOn(
      ctx.frmHome,
      p.session_id,
      ctx.executors.get(executorId)?.executor,
    ),
    mcpToken: await mintToken(),
    toolset: toolset.value,
    successor: successor.value,
    at: at.value,
    gate: o.gate ?? null,
  });
}

/**
 * Which project a spawn's work is, apart from where it runs: the workspace its payload
 * names — a gate's parity job names its ticket's, yet runs with no worktree (`workspace: "none"`,
 * an earlier change H2), so the workspace it was placed in is null — else where it was placed, else its
 * agent's (a pulse runs with no workspace of its own). Admission's project hold and the project's
 * step tier both read it, so they name one project.
 */
export const spawnProject = (
  r: Pick<Resolved, "payload" | "workspaceId" | "agent">,
): string | null =>
  r.payload.workspace_id ?? r.workspaceId ?? r.agent.workspace_id;

/** The workspace and executor; a successor's are its worktree's (M2-c). */
async function placeOf(
  ctx: Ctx,
  p: SessionSpawnPayload,
  agent: AgentRow,
  o: ResolveOptions,
  successor: Successor | null,
): Promise<
  Result<{ readonly workspaceId: string | null; readonly executorId: string }>
> {
  // A successor placed afresh (no worktree in its chain) takes the normal path.
  if (successor?.worktree != null) {
    return successorPlace(p, successor, successor.worktree);
  }
  const workspaceId =
    o.workspace === "none" ? null : (p.workspace_id ?? agent.workspace_id);
  const executorId = await pickExecutor(ctx, p, agent, workspaceId);
  return executorId.ok
    ? ok({ workspaceId, executorId: executorId.value })
    : executorId;
}

/**
 * The runner and its adapter. A disabled row is admission's `disabled` gate, decided there. An
 * unloaded adapter is refused here as that same gate 1 (the toolset needs the adapter), which is
 * sound because no gate precedes it.
 */
async function usableRunner(
  ctx: Ctx,
  id: string,
): Promise<Result<{ row: RunnerRow; adapter: RunnerAdapter }>> {
  const row = await getRunner(ctx.db, id);
  if (!row.ok) return row;
  const adapter = ctx.adapters.get(id);
  return adapter === undefined
    ? err(
        admissionRefused({
          kind: "refuse",
          gate: "disabled",
          detail: `no adapter is loaded for runner ${id}`,
        }),
      )
    : ok({ row: row.value, adapter });
}

async function agentProfile(
  ctx: Ctx,
  agent: AgentRow,
  runnerId: string,
  /** InternalSpawn.profileId: used instead of the agent's, and held to the runner the same way. */
  override?: string,
): Promise<Result<ProfileRow>> {
  const profileId = override ?? agent.profile_id;
  if (profileId === null) {
    return invalid(`agent ${agent.id} has no profile`);
  }
  const profile = await getProfile(ctx.db, profileId);
  if (!profile.ok || profile.value.runner_id === runnerId) return profile;
  return invalid(
    `profile ${profile.value.id} is for runner ${profile.value.runner_id}, not ${runnerId}`,
  );
}

async function pickExecutor(
  ctx: Ctx,
  p: SessionSpawnPayload,
  agent: AgentRow,
  workspaceId: string | null,
): Promise<Result<string>> {
  const ws =
    workspaceId === null ? ok(null) : await getWorkspace(ctx.db, workspaceId);
  if (!ws.ok) return ws;
  const id =
    p.executor_id ?? agent.executor_id ?? ws.value?.default_executor_id ?? null;
  if (id === null) {
    return invalid("no executor in the command, the agent or the workspace");
  }
  const row = await getExecutor(ctx.db, id);
  return row.ok ? ok(id) : row;
}

/** The run class in force by name: its row, else the §8.4 default. */
export async function findRunClass(
  ctx: Ctx,
  name: string,
): Promise<Result<RunClass>> {
  const classes = await loadRunClasses(async () => {
    const rows = await listRunClasses(ctx.db);
    if (!rows.ok) throw rows.error;
    return rows.value;
  });
  if (!classes.ok) return classes;
  const found = classes.value.get(name);
  return found === undefined ? invalid(`no run class ${name}`) : ok(found);
}

/**
 * The session's tier and its active model (§9.8): the role binding's
 * `model_tier` when it sets one — the operator's per-role choice, so it wins — else its project's
 * tier for the step its run class is, else the profile's. The same db read the reviewer pick checks
 * certification with (bindingModelOn), so the two agree. No model is admission's `no_model`, decided
 * there, not a resolve error; an uncertified one is its `uncertified`.
 */
async function tierModel(
  ctx: Ctx,
  role: string,
  runnerId: string,
  profile: ProfileRow,
  step: StepRef,
): Promise<Result<{ readonly tier: string; readonly model: ModelRow | null }>> {
  if (!ModelTier.safeParse(profile.model_tier).success) {
    return invalid(
      `profile ${profile.id} model_tier ${profile.model_tier} is not a tier`,
    );
  }
  const found = await bindingModelOn(ctx.db, role, runnerId, profile.id, step);
  if (!found.ok) return found;
  return ok({
    tier: found.value.tier ?? profile.model_tier,
    model: found.value.model,
  });
}

async function missionOf(
  ctx: Ctx,
  agent: AgentRow,
): Promise<
  Result<{ readonly hash: string | null; readonly text: string | null }>
> {
  if (agent.mission_id === null) return ok({ hash: null, text: null });
  const mission = await getMission(ctx.db, agent.mission_id);
  if (!mission.ok) return mission;
  const text = mission.value.rendered_md;
  return ok({ hash: await sha256Hex(text), text });
}

/** Edge 1, once admission's gates 1–5 passed. A re-delivered session_id finds its row: `created:
 * false`, and nothing runs twice. */
export async function createSessionRow(
  ctx: Ctx,
  r: Resolved & { readonly model: ModelRow },
  /**
   * The zod-parsed session.spawn payload, stored while the row is pending so a restart can
   * re-admit it. Only spawnSession passes it; internal spawns never do.
   */
  spawnRequest?: SessionSpawnPayload,
): Promise<Result<{ created: boolean }>> {
  const created = await createSession(ctx.db, {
    id: r.sessionId,
    spawn_request_json:
      spawnRequest === undefined ? null : JSON.stringify(spawnRequest),
    agent_id: r.agent.id,
    ticket_id: r.payload.ticket_id ?? null,
    role: r.payload.role,
    run_class: r.runClass.name,
    runner_id: r.runner.id,
    executor_id: r.executorId,
    model: r.model.model,
    model_tier: r.model.tier,
    effort: r.model.effort,
    context_ruleset: pinnedRuleset(r.compression),
    workspace_id: r.workspaceId,
    session_root: r.paths.root,
    home_dir: r.paths.home,
    config_hash: r.configHash,
    mission_hash: r.missionHash,
    raw_log_path: r.paths.rawLog,
    toolset_hash: r.toolset.hash,
    mcp_token_hash: r.mcpToken.hash,
    // M2-c: handoff_accept with no id takes handoff_in_id; owning is accept's, not ours.
    predecessor_session_id: r.successor?.predecessorId ?? null,
    handoff_in_id: r.successor?.handoff.id ?? null,
    // M3-h: the reviewer's gate (decideGate checks it) and a fallback's bound runner (§9.8).
    gate_id: r.gate?.id ?? null,
    fallback_from_runner_id: r.gate?.fallbackFrom ?? null,
  });
  if (created.ok) return ok({ created: true });
  if (created.error.class !== "conflict") return created;
  const existing = await getSession(ctx.db, r.sessionId);
  return existing.ok ? ok({ created: false }) : created;
}
