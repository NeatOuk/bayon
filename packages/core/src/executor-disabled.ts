// The kill switch, read the same way wherever work is placed on an executor (§6.1,
//). `executors.enabled = 0` is the operator taking a box out of service: admission
// already refuses a session spawn on one at its `disabled` gate, and `runner.conformance` — minutes
// of real spend, spawning its sessions straight through the executor rather than through admission
// (§15) — refuses with the same class, the same gate and the same shape, so one switch stops every
// kind of work rather than only the kind admission happens to guard.
import { admissionRefused } from "./admission.js";
import type { FrmError } from "./errors.js";

export interface EnabledCheck {
  readonly executorId: string;
  /** The executor row's `enabled` column, as a boolean. */
  readonly enabled: boolean;
}

/**
 * Why no work may be placed on that executor, as the typed error to refuse with; null when it is
 * enabled. Not retryable: nothing clears it but the operator enabling the executor again, which the
 * message names so a refusal reads as an instruction rather than a mystery.
 */
export function disabledExecutorRefusal(c: EnabledCheck): FrmError | null {
  return c.enabled
    ? null
    : admissionRefused({
        kind: "refuse",
        gate: "disabled",
        detail: `executor ${c.executorId} is disabled: it is out of service, so no work is placed on it. Enable it first: frm executor enable ${c.executorId}`,
      });
}
