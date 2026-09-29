import { ExecutorView, type ExecutorsView } from "@bayon/proto";

// Wire-shaped executors (DTOs): every value here passes its proto schema.

export const executorView = (
  o: Partial<ExecutorView> & Pick<ExecutorView, "id">,
): ExecutorView =>
  ExecutorView.parse({
    kind: "local",
    trust: "trusted",
    egress_policy: "open",
    slots: 4,
    enabled: true,
    health: "healthy",
    health_checked_at: 1_800_000_000_000,
    health_detail: null,
    config: {},
    ...o,
  });

export const executorsView = (
  executors: readonly ExecutorView[],
  untrustedRoles: readonly string[] | null = ["investigator"],
): ExecutorsView => ({
  executors: [...executors],
  untrusted_roles: untrustedRoles === null ? null : [...untrustedRoles],
});
