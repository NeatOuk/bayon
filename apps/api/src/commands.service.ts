import {
  err,
  newId,
  ok,
  type Clock,
  type FrmError,
  type Result,
} from "@bayon/core";
import {
  Command,
  SpawnRequest,
  type AttachRequest,
  type CommandAccepted,
  type ExecutorHealthAccepted,
  type ExportRunAccepted,
  type PulseRunAccepted,
  type RunnerConformanceAccepted,
  type RunnerConformanceRequest,
  type SessionHandoffRequest,
  type SessionSpawnPayload,
  type StopMode,
} from "@bayon/proto";
import { Inject, Injectable } from "@nestjs/common";
import type { ApiStore } from "./store.js";
import { API_STORE, CLOCK } from "./tokens.js";

const KEY_REUSED: FrmError = {
  class: "conflict",
  message: "Idempotency-Key was already used for a different request",
  retryable: false,
};

const SPAWN_FIELDS = SpawnRequest.keyof().options;

const sameSpawn = (stored: SessionSpawnPayload, body: SpawnRequest): boolean =>
  SPAWN_FIELDS.every((field) => stored[field] === body[field]);

/** Turns requests into `commands` rows. It never spawns, interrupts or stops anything itself. */
@Injectable()
export class CommandsService {
  readonly #store: ApiStore;
  readonly #clock: Clock;

  constructor(@Inject(API_STORE) store: ApiStore, @Inject(CLOCK) clock: Clock) {
    this.#store = store;
    this.#clock = clock;
  }

  /**
   * One `session.spawn` row with a freshly minted `session_id`. A repeated Idempotency-Key with the
   * same body answers with the first command and its session; a different body is `conflict`.
   */
  async spawn(
    body: SpawnRequest,
    key: string | undefined,
  ): Promise<Result<CommandAccepted>> {
    if (key !== undefined) {
      const earlier = await this.#earlierSpawn(body, key);
      if (earlier) return earlier;
    }
    const sessionId = newId(this.#clock.now());
    const inserted = await this.#store.insertCommand({
      command: {
        type: "session.spawn",
        payload: { ...body, session_id: sessionId },
      },
      idempotencyKey: key,
    });
    if (inserted.ok)
      return ok({
        command_id: inserted.value.id,
        session_id: sessionId,
        created: inserted.value.created,
      });
    // A concurrent request with the same key inserted first: answer as it did.
    if (key !== undefined && inserted.error.class === "conflict")
      return (await this.#earlierSpawn(body, key)) ?? inserted;
    return inserted;
  }

  interrupt(sessionId: string, key: string | undefined) {
    return this.#forSession(
      { type: "session.interrupt", payload: { session_id: sessionId } },
      key,
    );
  }

  stop(sessionId: string, mode: StopMode, key: string | undefined) {
    return this.#forSession(
      { type: "session.stop", payload: { session_id: sessionId, mode } },
      key,
    );
  }

  /**
   * §12.5: the operator takes the session's attach lease. Answers 202 like every other session
   * command — the supervisor mints the lease and starts the interactive process asynchronously;
   * poll `GET /sessions/:id` for `attach_lease_owner`/`tmux_target` once claimed (Ticket B's pty
   * WS gateway is what a browser actually connects to; this route only starts the process).
   * `when: "turn_end"` waits for the open run's end instead of stopping it mid-turn;
   * `attach_intent_at` shows the takeover pending meanwhile.
   */
  attach(sessionId: string, body: AttachRequest, key: string | undefined) {
    return this.#forSession(
      {
        type: "session.attach",
        // Absent, not undefined: a payload is stored as JSON, which has no undefined (a body with
        // no client_token was refused as "not JSON" before).
        payload: {
          session_id: sessionId,
          ...(body.client_token === undefined
            ? {}
            : { client_token: body.client_token }),
          when: body.when,
        },
      },
      key,
    );
  }

  /**
   * §12.5: releases the attach lease early (TTL expiry does it too, on its own); before the attach
   * has happened, cancels a pending "take over after this step".
   */
  detach(sessionId: string, key: string | undefined) {
    return this.#forSession(
      { type: "session.detach", payload: { session_id: sessionId } },
      key,
    );
  }

  /** One `session.handoff` (§7.1): the operator's hand-off of a live session, now. */
  handoff(
    sessionId: string,
    body: SessionHandoffRequest,
    key: string | undefined,
  ) {
    return this.#forSession(
      {
        type: "session.handoff",
        payload: {
          session_id: sessionId,
          reason: body.reason,
          ...(body.note === undefined ? {} : { note: body.note }),
        },
      },
      key,
    );
  }

  /**
   * One `export.run` row (contract 5/6). No session to mint or look up here -- the
   * supervisor decides whether to reuse the exporter's live session or spawn one
   * (`spawnExportIfIdle`), so this never returns a `session_id`. The payload is always `{}`, so a
   * repeated Idempotency-Key is always "the same command": `insertCommand`'s own dedup handles it.
   */
  async exportsRun(
    key: string | undefined,
  ): Promise<Result<ExportRunAccepted>> {
    const inserted = await this.#store.insertCommand({
      command: { type: "export.run", payload: {} },
      idempotencyKey: key,
    });
    return inserted.ok
      ? ok({ command_id: inserted.value.id, created: inserted.value.created })
      : inserted;
  }

  /**
   * One `pulse.run` for an orchestrator (§9.7 manual, POST /pulses/run-now). It skips the gap, not
   * the lease. An unknown agent is `not_found`; any other kind is `validation`.
   */
  async pulseRun(
    agentId: string,
    key: string | undefined,
  ): Promise<Result<PulseRunAccepted>> {
    const kind = await this.#store.agentKind(agentId);
    if (!kind.ok) return kind;
    if (kind.value !== "orchestrator") {
      return err({
        class: "validation",
        message: `agent ${agentId} is a ${kind.value}: only an orchestrator pulses`,
        retryable: false,
      });
    }
    const inserted = await this.#store.insertCommand({
      command: { type: "pulse.run", payload: { agent_id: agentId } },
      idempotencyKey: key,
    });
    return inserted.ok
      ? ok({ command_id: inserted.value.id, created: inserted.value.created })
      : inserted;
  }

  /**
   * One `runner.conformance` (§15): the suite for a runner on an executor, which the
   * supervisor runs and certifies. An unknown runner or executor is `not_found` and inserts nothing.
   */
  async runnerConformance(
    runnerId: string,
    body: RunnerConformanceRequest,
    key: string | undefined,
  ): Promise<Result<RunnerConformanceAccepted>> {
    const target = await this.#store.conformanceTarget(
      runnerId,
      body.executor_id,
      body.model_id,
      body.compression === true,
    );
    if (!target.ok) return target;
    const inserted = await this.#store.insertCommand({
      command: {
        type: "runner.conformance",
        payload: {
          runner_id: runnerId,
          executor_id: body.executor_id,
          model_id: body.model_id,
          ...(body.report_dir === undefined
            ? {}
            : { report_dir: body.report_dir }),
          ...(body.compression === true ? { compression: true } : {}),
        },
      },
      idempotencyKey: key,
    });
    return inserted.ok
      ? ok({ command_id: inserted.value.id, created: inserted.value.created })
      : inserted;
  }

  /**
   * One `executor.health` (§6.1): the executor's own check, which the supervisor runs and
   * records. An unknown executor is `not_found` and inserts nothing.
   */
  async executorHealth(
    executorId: string,
    key: string | undefined,
  ): Promise<Result<ExecutorHealthAccepted>> {
    const known = await this.#store.executorExists(executorId);
    if (!known.ok) return known;
    const inserted = await this.#store.insertCommand({
      command: {
        type: "executor.health",
        payload: { executor_id: executorId },
      },
      idempotencyKey: key,
    });
    return inserted.ok
      ? ok({ command_id: inserted.value.id, created: inserted.value.created })
      : inserted;
  }

  /** The spawn already stored under `key`, or null when the key is new. */
  async #earlierSpawn(
    body: SpawnRequest,
    key: string,
  ): Promise<Result<CommandAccepted> | null> {
    const found = await this.#store.commandByIdempotencyKey(key);
    if (!found.ok) return found;
    if (found.value === null) return null;
    const stored = Command.safeParse({
      type: found.value.type,
      payload: found.value.payload,
    });
    if (
      !stored.success ||
      stored.data.type !== "session.spawn" ||
      !sameSpawn(stored.data.payload, body)
    )
      return err(KEY_REUSED);
    return ok({
      command_id: found.value.id,
      session_id: stored.data.payload.session_id,
      created: false,
    });
  }

  /** A command about an existing session; an unknown session is `not_found` and inserts nothing. */
  async #forSession(
    command: Extract<
      Command,
      {
        type:
          | "session.interrupt"
          | "session.stop"
          | "session.handoff"
          | "session.attach"
          | "session.detach";
      }
    >,
    key: string | undefined,
  ): Promise<Result<CommandAccepted>> {
    const sessionId = command.payload.session_id;
    const session = await this.#store.session(sessionId);
    if (!session.ok) return session;
    const inserted = await this.#store.insertCommand({
      command,
      idempotencyKey: key,
    });
    return inserted.ok
      ? ok({
          command_id: inserted.value.id,
          session_id: sessionId,
          created: inserted.value.created,
        })
      : inserted;
  }
}
