// The API's terminal output: Nest's own boot chatter — a line per module, per
// controller and per route, about 120 of them — hides the one line a person needs (`api listening
// on …`). This logger drops Nest's `log`-level lines from those boot contexts only; warnings,
// errors and every line of our own still print. FRM_LOG_LEVEL=debug (or trace) keeps them all.
import { ConsoleLogger } from "@nestjs/common";

/** Nest's boot-time contexts whose `log` lines say only that wiring happened. */
export const NEST_BOOT_CONTEXTS: ReadonlySet<string> = new Set([
  "InstanceLoader",
  "RoutesResolver",
  "RouterExplorer",
  "NestFactory",
  "NestApplication",
  "WebSocketsController",
]);

export class QuietLogger extends ConsoleLogger {
  override log(message: unknown, ...rest: unknown[]): void {
    const context = rest.at(-1);
    if (typeof context === "string" && NEST_BOOT_CONTEXTS.has(context)) return;
    super.log(message, ...rest);
  }
}

/** The logger main passes to Nest: the quiet one, unless FRM_LOG_LEVEL asks for everything. */
export const apiLogger = (
  env: Readonly<Record<string, string | undefined>>,
): QuietLogger | undefined =>
  env.FRM_LOG_LEVEL === "debug" || env.FRM_LOG_LEVEL === "trace"
    ? undefined
    : new QuietLogger();
