import { BindingRole, err, ok, type Result } from "@bayon/core";
import { allOk, check } from "../checks.js";
import {
  first,
  qb,
  returningOne,
  write,
  type Db,
  type Internals,
  type R,
} from "../connection.js";
import { failure } from "../errors.js";
import type { RoleBindingRow } from "../schema-work.js";
import { insertAudit } from "./audit.js";

// PUT /role-bindings (§9.8, §12.1): who runs what, one role per call. Runner, executor and profile
// ids come from their tables, never from code (Invariant 1). Certification is not checked here:
// pickReviewer checks it when a gate runs, per (runner, executor).

export interface RoleBindingPut {
  readonly role: string;
  readonly runner_id: string;
  readonly model_tier?: string | null;
  readonly executor_id?: string | null;
  readonly profile_id?: string | null;
  readonly fallback_runner_id?: string | null;
  readonly require_distinct_from?: string | null;
}

const isRole = (role: string): boolean => BindingRole.safeParse(role).success;

/** Upserts `role`'s binding and its audit_log row (`role_binding.put`) in one transaction. */
export async function putRoleBinding(
  db: Db,
  b: RoleBindingPut,
  /** Who set it: `operator`. */
  by: string,
): R<RoleBindingRow> {
  const distinct = b.require_distinct_from ?? null;
  const checked = allOk(
    check(
      isRole(b.role),
      `${b.role} is not a role: ${BindingRole.options.join(", ")}`,
    ),
    check(
      (b.fallback_runner_id ?? null) !== b.runner_id,
      "fallback_runner_id must differ from runner_id",
    ),
    check(
      distinct === null || isRole(distinct),
      `require_distinct_from names no role: ${distinct}`,
    ),
    check(by.trim().length > 0, "a role binding needs an actor"),
  );
  if (!checked.ok) return checked;
  return write(db, (ix) => {
    const refs = checkRefs(ix, b);
    if (!refs.ok) return refs;
    const values = {
      runner_id: b.runner_id,
      model_tier: b.model_tier ?? null,
      executor_id: b.executor_id ?? null,
      profile_id: b.profile_id ?? null,
      fallback_runner_id: b.fallback_runner_id ?? null,
      require_distinct_from: distinct,
      updated_by: by,
      updated_at: ix.clock.now(),
    };
    const row = returningOne(
      ix,
      qb
        .insertInto("role_bindings")
        .values({ role: b.role, ...values })
        .onConflict((oc) => oc.column("role").doUpdateSet(values))
        .returningAll(),
    );
    if (!row.ok) return row;
    const audit = insertAudit(ix, {
      actor: by,
      action: "role_binding.put",
      target_kind: "role_binding",
      target_id: b.role,
      payload: {
        runner_id: values.runner_id,
        fallback_runner_id: values.fallback_runner_id,
        executor_id: values.executor_id,
        profile_id: values.profile_id,
        model_tier: values.model_tier,
        require_distinct_from: values.require_distinct_from,
      },
    });
    return audit.ok ? row : audit;
  });
}

/** Every id the binding names exists in its table; the first missing one is not_found. */
function checkRefs(ix: Internals, b: RoleBindingPut): Result<void> {
  const runners = [b.runner_id, b.fallback_runner_id ?? null].filter(
    (id): id is string => id !== null,
  );
  for (const id of runners) {
    const found = first(
      ix,
      qb.selectFrom("runners").select("id").where("id", "=", id),
    );
    if (found === undefined) {
      return err(failure("not_found", `runner ${id} does not exist`));
    }
  }
  if (b.executor_id != null) {
    const found = first(
      ix,
      qb.selectFrom("executors").select("id").where("id", "=", b.executor_id),
    );
    if (found === undefined) {
      return err(
        failure("not_found", `executor ${b.executor_id} does not exist`),
      );
    }
  }
  if (b.profile_id != null) {
    const found = first(
      ix,
      qb.selectFrom("profiles").select("id").where("id", "=", b.profile_id),
    );
    if (found === undefined) {
      return err(
        failure("not_found", `profile ${b.profile_id} does not exist`),
      );
    }
  }
  return ok(undefined);
}
