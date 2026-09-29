import type { CreateExecutorRequest } from "@bayon/proto";
import { ContainerExecutorConfig } from "@bayon/executors";

const DEFAULT_BASE = ContainerExecutorConfig.shape.base_image.parse(undefined);
const DEFAULT_NETWORK = "frm-internal";

export interface ExecutorSshConfig {
  readonly ssh: Record<string, unknown>;
  readonly config: Record<string, unknown>;
}

// The route's half of the glue `frm executor add`'s `addCommand` also does: the wire
// request's fields into exactly the `{ssh, config}` shape `ContainerExecutorConfig.safeParse`
// checks and `createExecutor` writes (minus `ssh.known_hosts`, filled in once the host key is
// pinned). Pure and I/O-free, so the CLI and the route can be proven to build the same object for
// the same input (the equality test), not just trusted to.
export function toExecutorConfig(
  body: CreateExecutorRequest,
): ExecutorSshConfig {
  const ssh: Record<string, unknown> = {
    host: body.host,
    user: body.user,
    identity_ref: body.identity_ref,
    ...(body.port === undefined ? {} : { port: body.port }),
  };
  const config: Record<string, unknown> = {
    remote_root: body.remote_root,
    image: body.base_image ?? DEFAULT_BASE,
    ...(body.base_image === undefined ? {} : { base_image: body.base_image }),
    network: body.network ?? DEFAULT_NETWORK,
    egress_allow: body.egress_allow ?? [],
    ...(body.min_free_pct === undefined
      ? {}
      : { min_free_pct: body.min_free_pct }),
    ...(body.quota_gb === undefined ? {} : { quota_gb: body.quota_gb }),
  };
  return { ssh, config };
}
