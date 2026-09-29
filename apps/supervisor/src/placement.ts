// Executors from their rows. At boot the lifecycle loads every
// enabled `executors` row as an executor admission can place sessions on: `local` is this process's
// own LocalExecutor; `container` a ContainerExecutor over ssh holding the /mcp reverse
// tunnel. A row that cannot be built is logged and skipped, so admission refuses it as
// "not loaded". Runner names never appear here: the gateway's hosts come from runner defaults.
import { ok, type JsonValue, type Result } from "@bayon/core";
import { listExecutors, type Db, type ExecutorRow } from "@bayon/db";
import {
  ContainerExecutor,
  SlotCounter,
  type ContainerExecutorOptions,
  type Executor,
} from "@bayon/executors";
import type { RunnerAdapter } from "@bayon/runners";
import { z } from "zod";
import type { ExecutorSlots, Log } from "./lifecycle/context.js";

/** An executor this supervisor must close at shutdown: its tunnel and ssh master. */
export type ClosableExecutor = Executor & { close(): Promise<void> };

export interface PlacementOptions {
  readonly frmHome: string;
  /** The API's /mcp as the supervisor reaches it; a container executor's tunnel carries it. */
  readonly mcpUrl: string;
  /** This process's local executor and its slots. */
  readonly local: ExecutorSlots;
  /** The runners' `egressHosts`: its gateway allows them beside the row's own `egress_allow`. */
  readonly egressHosts: readonly string[];
  readonly log: Log;
  /** Builds a container executor; tests pass one over a loopback. */
  readonly container?: (o: ContainerExecutorOptions) => ClosableExecutor;
  /** FRM_HOME_TAG: each container executor labels its sessions' containers frm.home with it. */
  readonly homeTag?: string;
}

export interface Placement {
  /** The local executor, and every enabled container row that builds. Call once, at boot. */
  load(db: Db): Promise<Result<ReadonlyMap<string, ExecutorSlots>>>;
  /** What the last `load` built: the local executor alone before it. */
  loaded(): ReadonlyMap<string, ExecutorSlots>;
  /** Closes what `load` built (tunnels, ssh masters); the local executor needs nothing. */
  close(): Promise<void>;
}

const Defaults = z.looseObject({ egressHosts: z.array(z.string()).optional() });

/** Every adapter's `egressHosts` default, sorted and deduplicated. */
export function egressHostsOf(
  adapters: ReadonlyMap<string, RunnerAdapter>,
): string[] {
  const hosts = [...adapters.values()].flatMap((adapter) => {
    const d = Defaults.safeParse(adapter.registration().runner.defaults);
    return d.success ? (d.data.egressHosts ?? []) : [];
  });
  return [...new Set(hosts)].toSorted();
}

function parseJson(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

export function createPlacement(o: PlacementOptions): Placement {
  const build = o.container ?? ((c) => new ContainerExecutor(c));
  const localOnly: ReadonlyMap<string, ExecutorSlots> = new Map([
    [o.local.executor.id, o.local],
  ]);
  let current = localOnly;
  let built: readonly ClosableExecutor[] = [];

  const container = (row: ExecutorRow): ExecutorSlots | null => {
    try {
      const slots = new SlotCounter(row.slots);
      const executor = build({
        id: row.id,
        slots,
        frmHome: o.frmHome,
        // The executor parses it: its zod schema is the boundary.
        config: (parseJson(row.config_json) ??
          {}) as ContainerExecutorOptions["config"],
        egressHosts: o.egressHosts,
        mcpUrl: o.mcpUrl,
        ...(o.homeTag === undefined ? {} : { homeTag: o.homeTag }),
        onDiagnostic: (d) =>
          o.log.warn(
            { executor: row.id, diagnostic: d },
            "executor diagnostic",
          ),
      });
      built = [...built, executor];
      return { executor, slots };
    } catch (e) {
      o.log.error(
        { executor: row.id, err: String(e) },
        "cannot build the executor from its row: admission refuses it",
      );
      return null;
    }
  };

  return {
    async load(db) {
      const rows = await listExecutors(db);
      if (!rows.ok) return rows;
      const placed = rows.value
        .filter((row) => row.enabled === 1 && row.id !== o.local.executor.id)
        .flatMap((row): [string, ExecutorSlots][] => {
          if (row.kind !== "container") {
            o.log.warn(
              { executor: row.id, kind: row.kind },
              "no executor of this kind runs here yet: admission refuses it",
            );
            return [];
          }
          const made = container(row);
          return made === null ? [] : [[row.id, made]];
        });
      current = new Map([...localOnly, ...placed]);
      return ok(current);
    },
    loaded: () => current,
    async close() {
      const closing = built;
      built = [];
      current = localOnly;
      await Promise.all(
        closing.map((e) =>
          e.close().catch((err: unknown) => {
            o.log.warn(
              { executor: e.id, err: String(err) },
              "closing the executor failed",
            );
          }),
        ),
      );
    },
  };
}
