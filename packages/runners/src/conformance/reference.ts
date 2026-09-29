// The offline reference ports, together: memory ingest, reference watchdog, local MCP probe and
// local workspace. Never certifiable (`source: 'reference'`); an earlier change injects the supervisor's.
import type { Clock } from "@bayon/core";
import { referenceMcpProbe } from "./mcp-probe.js";
import { createMemoryIngest } from "./memory-ingest.js";
import type { Budgets, ConformancePorts } from "./types.js";
import { createReferenceWatchdog } from "./watchdog.js";
import { createLocalWorkspace } from "./workspace.js";

export async function createReferencePorts(o: {
  readonly clock: Clock;
  readonly budgets: Budgets;
}): Promise<ConformancePorts> {
  const ingest = createMemoryIngest({ clock: o.clock });
  return {
    clock: o.clock,
    ingest,
    watchdog: createReferenceWatchdog({
      clock: o.clock,
      ingest,
      graceMs: o.budgets.graceMs,
      stopMs: o.budgets.callMs + 2 * o.budgets.graceMs,
    }),
    mcp: referenceMcpProbe,
    workspace: await createLocalWorkspace(),
  };
}
