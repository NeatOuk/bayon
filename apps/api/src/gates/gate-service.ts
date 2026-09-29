import { ok, type Result } from "@bayon/core";
import {
  listGateFindings,
  listGateSessions,
  listBoundModels,
  listRoleBindings,
  type Db,
  type GateRow,
} from "@bayon/db";
import {
  putRoleBinding,
  rerunGate,
  resolveFinding,
  waiveFinding,
  waiveGate,
} from "@bayon/db/api";
import type {
  FindingView,
  GateRunAccepted,
  GateView,
  GatesPage,
  GatesQuery,
  PutRoleBinding,
  ResolveFindingRequest,
  RoleBindingView,
  RoleBindingsPage,
} from "@bayon/proto";
import { actorRef } from "../tickets/law-facts.js";
import {
  toFindingView,
  toGateViews,
  toRoleBindingView,
  toRoleBindingViews,
} from "../tickets/ticket-views.js";
import { gatesPage } from "./gate-views.js";

// The operator's gate, finding and role-binding routes (§12.1, §7). Every write
// is one of @bayon/db/api's writers, each a BEGIN IMMEDIATE with its checks inside. Sessions reach
// finding resolution through finding_resolve (MCP), never here.

export interface GateServiceDeps {
  readonly db: Db;
}

/** REST callers are the operator (§12.1). */
const OPERATOR = actorRef({ kind: "operator" });

export class GateService {
  readonly #db: Db;

  constructor(deps: GateServiceDeps) {
    this.#db = deps.db;
  }

  /** GET /gates: latest attempts by default, newest first. */
  list(q: GatesQuery): Promise<Result<GatesPage>> {
    return gatesPage(this.#db, {
      latest: q.latest,
      limit: q.limit,
      ...(q.state === undefined ? {} : { states: q.state }),
      ...(q.ticket === undefined ? {} : { ticket: q.ticket }),
      ...(q.project === undefined ? {} : { project: q.project }),
      ...(q.cursor === undefined ? {} : { cursor: q.cursor }),
    });
  }

  /** POST /gates/:id/run: the next attempt for the gate's repo, with its gate.run command. */
  async run(id: string): Promise<Result<GateRunAccepted>> {
    const opened = await rerunGate(this.#db, { gate_id: id, by: OPERATOR });
    return opened.ok
      ? ok({
          gate_id: opened.value.gate.id,
          attempt: opened.value.gate.attempt,
          command_id: opened.value.command_id,
          session_id: opened.value.session_id,
        })
      : opened;
  }

  /** POST /gates/:id/waive: running | failed → waived, with the reason shown forever. */
  async waive(id: string, reason: string): Promise<Result<GateView>> {
    const row = await waiveGate(this.#db, {
      gate_id: id,
      reason,
      by: OPERATOR,
    });
    return row.ok ? this.#view(row.value) : row;
  }

  /** POST /findings/:id/resolve: the fixing run must work the finding's ticket. */
  async resolveFinding(
    id: string,
    body: ResolveFindingRequest,
  ): Promise<Result<FindingView>> {
    const row = await resolveFinding(this.#db, {
      finding_id: id,
      run_id: body.run_id,
      note: body.note,
      by: OPERATOR,
    });
    return row.ok ? toFindingView(row.value) : row;
  }

  /** POST /findings/:id/waive. */
  async waiveFinding(id: string, reason: string): Promise<Result<FindingView>> {
    const row = await waiveFinding(this.#db, {
      finding_id: id,
      reason,
      by: OPERATOR,
    });
    return row.ok ? toFindingView(row.value) : row;
  }

  /** GET /role-bindings, each with the model it runs on its runner. */
  async roleBindings(): Promise<Result<RoleBindingsPage>> {
    const rows = await listRoleBindings(this.#db);
    if (!rows.ok) return rows;
    const items = toRoleBindingViews(rows.value);
    if (!items.ok) return items;
    const withModels = await this.#withModels(items.value);
    return withModels.ok ? ok({ items: withModels.value }) : withModels;
  }

  /** Each binding's model on its own runner, from the bound models db computes (never here). */
  async #withModels(
    views: readonly RoleBindingView[],
  ): Promise<Result<RoleBindingView[]>> {
    const bound = await listBoundModels(this.#db);
    if (!bound.ok) return bound;
    return ok(
      views.map((v) => {
        const own = bound.value.find(
          (b) => b.step === null && b.role === v.role && !b.fallback,
        );
        return {
          ...v,
          model_id: own?.model_id ?? null,
          model: own?.model ?? null,
        };
      }),
    );
  }

  /** PUT /role-bindings: one role, ids checked against their tables; no certification check. */
  async putRoleBinding(body: PutRoleBinding): Promise<Result<RoleBindingView>> {
    const row = await putRoleBinding(
      this.#db,
      {
        role: body.role,
        runner_id: body.runner_id,
        ...(body.model_tier === undefined
          ? {}
          : { model_tier: body.model_tier }),
        ...(body.executor_id === undefined
          ? {}
          : { executor_id: body.executor_id }),
        ...(body.profile_id === undefined
          ? {}
          : { profile_id: body.profile_id }),
        ...(body.fallback_runner_id === undefined
          ? {}
          : { fallback_runner_id: body.fallback_runner_id }),
        ...(body.require_distinct_from === undefined
          ? {}
          : { require_distinct_from: body.require_distinct_from }),
      },
      "operator",
    );
    if (!row.ok) return row;
    const view = toRoleBindingView(row.value);
    if (!view.ok) return view;
    const [withModel] = await this.#withModels([view.value]).then((r) =>
      r.ok ? r.value : [view.value],
    );
    return ok(withModel ?? view.value);
  }

  async #view(gate: GateRow): Promise<Result<GateView>> {
    const [findings, sessions] = await Promise.all([
      listGateFindings(this.#db, gate.id),
      listGateSessions(this.#db, [gate.id]),
    ]);
    if (!findings.ok) return findings;
    if (!sessions.ok) return sessions;
    const views = toGateViews([gate], findings.value, sessions.value);
    if (!views.ok) return views;
    const [view] = views.value;
    return view === undefined
      ? {
          ok: false,
          error: {
            class: "internal",
            message: `gate ${gate.id} has no view`,
            retryable: false,
          },
        }
      : ok(view);
  }
}
