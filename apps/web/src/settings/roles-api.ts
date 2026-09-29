import {
  RoleBindingView,
  RoleBindingsPage,
  type PutRoleBinding,
} from "@bayon/proto";
import { queryOptions } from "@tanstack/react-query";
import { getJson, putJson } from "@/api/http";

// Settings → Roles' REST (§9.8, §12.1): GET /role-bindings and PUT /role-bindings, which
// replaces one role's binding whole. Role bindings are rows, never code (Invariant 1).

/** GET /role-bindings; a saved binding refreshes it by this key. */
export const ROLE_BINDINGS_KEY = ["role-bindings"] as const;

export const roleBindingsQuery = queryOptions({
  queryKey: ROLE_BINDINGS_KEY,
  queryFn: ({ signal }) => getJson("/role-bindings", RoleBindingsPage, signal),
});

/** One role's binding, replaced whole; 404 names an unknown runner, executor or profile. */
export const putRoleBinding = (
  binding: PutRoleBinding,
): Promise<RoleBindingView> =>
  putJson("/role-bindings", binding, RoleBindingView);
