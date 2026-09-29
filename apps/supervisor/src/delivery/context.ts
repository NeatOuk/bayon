import type { Ctx } from "../lifecycle/context.js";

// What delivery uses of the lifecycle: the database, the clock, the log, the host
// secret store, and what host git needs (the deadline setting and PATH). The CI sweep
// also writes a gate's check list under $FRM_HOME, so it needs `frmHome`. Narrow on purpose — a test
// world builds one of these by hand, without an executor, an admission queue or a watchdog.
export type DeliveryCtx = Pick<
  Ctx,
  | "db"
  | "frmHome"
  | "clock"
  | "log"
  | "settings"
  | "path"
  | "secrets"
  | "forgeFetch"
  | "forgeRemoteOf"
>;
