// Names in an FRM_HOME that more than one process must agree on (§11.3).

/**
 * The supervisor lock (Invariant 12): the supervisor holds it for its lifetime, and `frm restore`
 * refuses a target while it is there. One name, so the two can never drift apart.
 */
export const SUPERVISOR_LOCK_FILE = "supervisor.lock";
