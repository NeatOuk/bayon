import { canonicalJson, err, ok, type Clock, type Result } from "@bayon/core";
import { getExecutor, type Db } from "@bayon/db";
import { createExecutor } from "@bayon/db/api";
import {
  ContainerExecutorConfig,
  EXECUTOR_ID,
  pinKnownHosts,
} from "@bayon/executors";
import type { CreateExecutorRequest, ExecutorCreated } from "@bayon/proto";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { toExecutorConfig } from "./executor-plan.js";

// POST /executors (§9.5 amendment): the same order `frm executor add` already checks
// in, so the two doors can never disagree — an id conflict first (before the host key is ever
// touched), then ContainerExecutorConfig's own validation, then the host-key pin (never a scan),
// then the write. A class over {db, clock, frmHome}, matching ProjectsService's shape.

export interface ExecutorsCreateServiceDeps {
  readonly db: Db;
  readonly clock: Clock;
  /** `$FRM_HOME`; null without it, refused as a host-misconfiguration `validation`. */
  readonly frmHome: string | null;
  /**
   * The known_hosts file this door pins from. Never wire-settable (security review):
   * a caller-chosen path would be a file-existence oracle over the API host's filesystem, gated
   * only by the shared bearer. Defaults to `~/.ssh/known_hosts`; tests override it directly.
   */
  readonly knownHostsPath?: string;
}

const invalid = (message: string): Result<never> =>
  err({ class: "validation", message, retryable: false });

export class ExecutorsCreateService {
  readonly #db: Db;
  readonly #frmHome: string | null;
  readonly #knownHostsPath: string;
  // A single-flight guard per id (security review): without it, two concurrent
  // requests for the same new id both pass the not-yet-taken check below, both pin a host key to
  // the same destination path, and only one wins the DB insert — leaving a known_hosts file that
  // may not match whichever row actually survived. One API process per install, so a plain
  // in-memory set fully closes this (a double-click, a retried fetch), which is the only case
  // that matters here.
  readonly #creating = new Set<string>();

  constructor(deps: ExecutorsCreateServiceDeps) {
    this.#db = deps.db;
    this.#frmHome = deps.frmHome;
    this.#knownHostsPath =
      deps.knownHostsPath ?? join(homedir(), ".ssh", "known_hosts");
  }

  async create(body: CreateExecutorRequest): Promise<Result<ExecutorCreated>> {
    const frmHome = this.#frmHome;
    if (frmHome === null) {
      return invalid("no FRM_HOME: set it before adding an executor");
    }
    if (!EXECUTOR_ID.test(body.id)) {
      return invalid(
        `executor id ${JSON.stringify(body.id)} must match ${EXECUTOR_ID.source}`,
      );
    }
    const { ssh, config } = toExecutorConfig(body);
    const checked = ContainerExecutorConfig.safeParse({ ...config, ssh });
    if (!checked.success) return invalid(z.prettifyError(checked.error));

    if (this.#creating.has(body.id)) {
      return err({
        class: "conflict",
        message: `executor ${body.id} is already being added; wait for that to finish`,
        retryable: true,
      });
    }
    this.#creating.add(body.id);
    try {
      return await this.#createLocked(body, ssh, config, checked.data, frmHome);
    } finally {
      this.#creating.delete(body.id);
    }
  }

  async #createLocked(
    body: CreateExecutorRequest,
    ssh: Record<string, unknown>,
    config: Record<string, unknown>,
    checked: {
      readonly ssh: { readonly host: string; readonly port: number };
      readonly network: string;
    },
    frmHome: string,
  ): Promise<Result<ExecutorCreated>> {
    // The CLI's own order: an existing id is refused before the host key is ever touched, so a
    // repeat call never re-pins (or overwrites) a key that's already trusted for that id.
    const existing = await getExecutor(this.#db, body.id);
    if (existing.ok) {
      return err({
        class: "conflict",
        message: `executor ${body.id} exists; its host key is not re-pinned`,
        retryable: false,
      });
    }
    if (existing.error.class !== "not_found") return existing;

    const knownHosts = join(frmHome, "executors", body.id, "known_hosts");
    const pinned = pinKnownHosts({
      from: this.#knownHostsPath,
      host: checked.ssh.host,
      port: checked.ssh.port,
      to: knownHosts,
    });
    if (!pinned.ok) return pinned;

    const written = await createExecutor(this.#db, {
      id: body.id,
      host: body.host,
      user: body.user,
      network: checked.network,
      slots: body.slots,
      row: {
        id: body.id,
        kind: "container",
        config_json: canonicalJson({
          ...config,
          ssh: { ...ssh, known_hosts: knownHosts },
        }),
        slots: body.slots,
        egress_policy: "allowlist",
        trust: "untrusted",
      },
    });
    if (!written.ok) return written;
    return ok({
      id: body.id,
      host: body.host,
      known_hosts_entries_copied: pinned.value,
    });
  }
}
