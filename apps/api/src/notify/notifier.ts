import { OPERATOR_SETTINGS, type Clock } from "@bayon/core";
import { notifySources, type Db } from "@bayon/db";
import { insertNotifications } from "@bayon/db/api";
import type { ChannelSet } from "./channels/index.js";
import { filingOf } from "./collect.js";
import { deliverDue, type NotifyLogger } from "./deliver.js";
import { loadNotifySettings } from "./settings.js";

// The notifier, in the API beside the Jira timer, on the injected clock. Every
// `notify.poll_ms` (read again each tick) one tick: read the moments past the watermarks and the arms
// standing, file each new one with its deliveries and move the watermarks in one transaction, then
// send what is due. It tails the DB, as the WS hub does, so it survives either process restarting:
// the outbox and the watermarks are the whole of its state. Nothing a tick meets is thrown out of
// the loop; it is logged, scrubbed.
//
// Pausing the fleet does not stop it: a paused fleet still has questions waiting.

const FALLBACK_POLL_MS = OPERATOR_SETTINGS["notify.poll_ms"].default;

export interface NotifierDeps {
  readonly db: Db;
  readonly clock: Clock;
  readonly channels: ChannelSet;
  readonly logger: NotifyLogger;
}

export class Notifier {
  readonly #deps: NotifierDeps;
  #stopper: AbortController | null = null;
  #loop: Promise<void> | null = null;
  /** The last tick's unreadable settings: logged when they change, not every tick. */
  #problems = "";

  constructor(deps: NotifierDeps) {
    this.#deps = deps;
  }

  /** Starts the loop; a second start while it runs does nothing. */
  start(): void {
    if (this.#loop !== null) return;
    const stopper = new AbortController();
    this.#stopper = stopper;
    this.#loop = this.#run(stopper.signal);
  }

  /** Stops the loop and waits for a tick in flight, whose sends it aborts. */
  async stop(): Promise<void> {
    this.#stopper?.abort();
    await this.#loop;
    this.#stopper = null;
    this.#loop = null;
  }

  async #pollMs(): Promise<number> {
    const { settings } = await loadNotifySettings(this.#deps.db);
    return settings.pollMs > 0 ? settings.pollMs : FALLBACK_POLL_MS;
  }

  async #run(signal: AbortSignal): Promise<void> {
    for (;;) {
      try {
        await this.#deps.clock.after(await this.#pollMs(), signal);
      } catch {
        return; // stop() aborted the wait
      }
      try {
        await this.tick(signal);
      } catch (e) {
        this.#deps.logger.error(
          `notify: a tick threw: ${e instanceof Error ? e.name : "a non-error"}`,
        );
      }
    }
  }

  /** One pass: collect, then deliver. Exposed for tests and the loop. */
  async tick(signal?: AbortSignal): Promise<void> {
    const { db, clock, logger } = this.#deps;
    const loaded = await loadNotifySettings(db);
    const problems = loaded.problems.join(", ");
    if (problems !== this.#problems && problems !== "")
      logger.warn(
        `notify: unreadable settings read as their defaults: ${problems}`,
      );
    this.#problems = problems;
    const rows = await notifySources(db);
    if (!rows.ok) {
      logger.error(`notify: the sources are unreadable: ${rows.error.message}`);
    } else {
      const filed = await insertNotifications(
        db,
        filingOf(rows.value, loaded.settings, clock.now()),
      );
      if (!filed.ok)
        logger.error(`notify: the outbox write failed: ${filed.error.message}`);
    }
    if (signal?.aborted === true) return;
    await deliverDue(this.#deps, loaded.settings, signal);
  }
}
