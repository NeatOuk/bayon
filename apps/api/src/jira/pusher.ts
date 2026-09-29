import { pushesOf, type Clock } from "@bayon/core";
import { jiraPushSources, type Db } from "@bayon/db";
import { fileJiraPushes } from "@bayon/db/api";
import type { Fetch } from "../atlassian/client.js";
import { deliverDuePushes, type PushLogger } from "./push-deliver.js";
import type { JiraTokenStore } from "./token.js";

// Jira follows the ticket: the pusher, in the API beside the notifier and the Jira
// timer, on the injected clock. Every JIRA_PUSH_POLL_MS one tick: read the ticket moves and
// delivered pull requests past the watermarks, file each push they call for and move the
// watermarks in one transaction, then send what is due. It tails the DB as the notifier does, so it
// survives either process restarting: the outbox and the watermarks are the whole of its state.
// Nothing a tick meets is thrown out of the loop; it is logged, scrubbed.
//
// Pausing the fleet does not stop it: it spawns nothing, it only tells Jira what already happened.

export const JIRA_PUSH_POLL_MS = 15_000;

export interface JiraPusherDeps {
  readonly db: Db;
  readonly clock: Clock;
  /** The host store JIRA_API_TOKEN is read from at each tick that sends: the mirror's own. */
  readonly token: JiraTokenStore;
  /** Global fetch in production; tests inject one. */
  readonly fetch?: Fetch;
  readonly logger: PushLogger;
  readonly pollMs?: number;
}

export class JiraPusher {
  readonly #deps: JiraPusherDeps;
  readonly #fetch: Fetch;
  #stopper: AbortController | null = null;
  #loop: Promise<void> | null = null;

  constructor(deps: JiraPusherDeps) {
    this.#deps = deps;
    this.#fetch = deps.fetch ?? ((url, init) => fetch(url, init));
  }

  /** Starts the loop; a second start while it runs does nothing. */
  start(): void {
    if (this.#loop !== null) return;
    const stopper = new AbortController();
    this.#stopper = stopper;
    this.#loop = this.#run(stopper.signal);
  }

  /** Stops the loop and waits for a tick in flight, whose requests it aborts. */
  async stop(): Promise<void> {
    this.#stopper?.abort();
    await this.#loop;
    this.#stopper = null;
    this.#loop = null;
  }

  async #run(signal: AbortSignal): Promise<void> {
    for (;;) {
      try {
        await this.#deps.clock.after(
          this.#deps.pollMs ?? JIRA_PUSH_POLL_MS,
          signal,
        );
      } catch {
        return; // stop() aborted the wait
      }
      try {
        await this.tick(signal);
      } catch (e) {
        this.#deps.logger.error(
          `jira push: a tick threw: ${e instanceof Error ? e.name : "a non-error"}`,
        );
      }
    }
  }

  /** One pass: file, then send. Exposed for tests and the loop. */
  async tick(signal?: AbortSignal): Promise<void> {
    const { db, logger } = this.#deps;
    const rows = await jiraPushSources(db);
    if (!rows.ok) {
      logger.error(
        `jira push: the sources are unreadable: ${rows.error.message}`,
      );
    } else {
      const filed = await fileJiraPushes(db, {
        items: pushesOf(rows.value),
        cursors: rows.value.advance,
      });
      if (!filed.ok)
        logger.error(
          `jira push: the outbox write failed: ${filed.error.message}`,
        );
    }
    if (signal?.aborted === true) return;
    await deliverDuePushes({ ...this.#deps, fetch: this.#fetch }, signal);
  }
}
