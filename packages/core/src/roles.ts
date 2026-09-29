// The roles a session does work as (§11.1). Here, not in @bayon/proto's MCP catalogue, because
// core's schemas have to name them: `executors.untrusted_roles` is a list of these and the trust
// rule (trust.ts) matches a role against it exactly, so a value that is not a role does not weaken
// the isolation boundary — it nulls it, and every door that writes the setting has to refuse one.
// proto depends on core, never the other way round; proto's McpRole is this list plus the
// conformance probe's role.
import { z } from "zod";

/** The roles that do work (§11.1): every shipped MCP allowlist is one of theirs. */
export const WORK_ROLES = [
  "orchestrator",
  "builder",
  "reviewer",
  "investigator",
] as const;

export const WorkRole = z.enum(WORK_ROLES);
export type WorkRole = z.infer<typeof WorkRole>;

export const isWorkRole = (role: string): role is WorkRole =>
  (WORK_ROLES as readonly string[]).includes(role);
