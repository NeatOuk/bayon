// The trust rule (plan cross-milestone rule 4, enforced from M3): a role listed
// in `executors.untrusted_roles`, or a spawn flagged `untrusted_input`, runs only on an executor
// whose trust is 'untrusted' (a container). Pure: admission reads the setting and the executor row,
// and refuses with the reason.

export interface TrustCheck {
  readonly role: string;
  /** The spawn is flagged `untrusted_input`: it reads content nobody vouched for. */
  readonly untrustedInput: boolean;
  /** The `executors.untrusted_roles` setting. */
  readonly untrustedRoles: readonly string[];
  readonly executorId: string;
  /** The executor row's `trust`. */
  readonly trust: string;
}

/** Why the spawn may not run on that executor, or null when it may. */
export function trustRefusal(c: TrustCheck): string | null {
  if (c.trust === "untrusted") return null;
  const why = c.untrustedRoles.includes(c.role)
    ? `role ${c.role} is in executors.untrusted_roles`
    : c.untrustedInput
      ? "the spawn is flagged untrusted_input"
      : null;
  return why === null
    ? null
    : `${why}: it needs a trust='untrusted' executor, and ${c.executorId} is ${c.trust}`;
}
