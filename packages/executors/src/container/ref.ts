// Container executor refs: `ctr:<executorId>:<container>:<n>`. The container
// is its id, never its name, so a re-created container never matches an old ref; `host` marks a
// docker-host exec. <n> is random, not a counter that would restart with the supervisor.
import { randomBytes } from "node:crypto";
import { frmError } from "../errors.js";

export const EXECUTOR_ID = /^[a-z0-9-]{1,32}$/;
const REF = /^ctr:([a-z0-9-]{1,32}):([0-9a-f]{12}|host):([0-9a-f]{16})$/;
const CONTAINER_ID = /^[0-9a-f]{12}$/;

export interface ContainerRef {
  readonly executorId: string;
  /** The 12-hex container id, or null for an exec on the docker host. */
  readonly container: string | null;
  readonly token: string;
}

export const mintToken = (): string => randomBytes(8).toString("hex");

export function formatRef(ref: ContainerRef): string {
  return `ctr:${ref.executorId}:${ref.container ?? "host"}:${ref.token}`;
}

/** `ref` must come from executor `executorId`; anything else is refused (`validation`). */
export function parseRef(ref: string, executorId: string): ContainerRef {
  const match = REF.exec(ref);
  if (match === null || match[1] !== executorId) {
    throw frmError(
      "validation",
      `not a ref of container executor ${executorId}: ${JSON.stringify(ref)}`,
    );
  }
  const [, , container = "", token = ""] = match;
  return {
    executorId,
    container: container === "host" ? null : container,
    token,
  };
}

export function assertExecutorId(id: string): string {
  if (!EXECUTOR_ID.test(id)) {
    throw frmError(
      "validation",
      `executor id ${JSON.stringify(id)} must match ${EXECUTOR_ID.source}`,
    );
  }
  return id;
}

/** docker prints 64-hex ids; refs and commands use the first 12. */
export function shortContainerId(id: string): string {
  const short = id.trim().slice(0, 12);
  if (!CONTAINER_ID.test(short)) {
    throw frmError("internal", `docker returned no container id: ${id}`);
  }
  return short;
}
