// What the pulse layer's parts share at run time: the deps, the settings in force and the little
// state the scheduler keeps in memory.
import type { PulseDeps } from "./ports.js";
import type { PulseSettings } from "./settings.js";

export interface PulseRuntime extends PulseDeps {
  readonly settings: () => PulseSettings;
  /** Pulse ids between their lease and their session link: the sweep leaves these alone (H4). */
  readonly inFlight: Set<string>;
  /** Session id → pulse id, for the session-ended hook. */
  readonly sessions: Map<string, string>;
  /** Keeps detached work for settled(); a rejection is logged under `what`. */
  readonly track: (what: string, work: Promise<unknown>) => void;
  /** Re-plans an agent whose pulse just ended: a row changed, so this cannot loop (H2). */
  readonly replan: (agentId: string) => void;
}
