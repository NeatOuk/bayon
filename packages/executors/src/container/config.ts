// `executors.config_json` for kind='container'.
// Every value that reaches a remote command line is constrained here, so the fixed scripts need
// no quoting. Unknown keys pass through.
import { z } from "zod";

/** Absolute, and only characters that need no shell quoting. */
const REMOTE_PATH = /^\/[A-Za-z0-9._/-]+$/;
const IMAGE_REF = /^(?:sha256:[0-9a-f]{64}|[a-z0-9][a-z0-9._/:@-]{0,254})$/;
/** A lowercase DNS name with at least one dot: what tinyproxy's allowlist holds. */
export const EGRESS_HOST =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const ms = (fallback: number) => z.number().int().positive().default(fallback);
const port = (fallback: number) =>
  z.number().int().min(1).max(65_535).default(fallback);

export const ContainerExecutorConfig = z.looseObject({
  ssh: z.object({
    host: z.string().regex(/^[A-Za-z0-9.-]{1,253}$/),
    port: z.number().int().min(1).max(65_535).default(22),
    user: z.string().regex(/^[a-z_][a-z0-9_-]{0,31}$/),
    /** Pinned by `frm executor add`; default `<FRM_HOME>/executors/<id>/known_hosts`. */
    known_hosts: z.string().startsWith("/").optional(),
    /** `file:<private key, 0600>` or `agent:<public key>`; never the key itself (§6.1). */
    identity_ref: z.string().regex(/^(?:file|agent):\/\S+$/),
    /** Idle time before the owned ControlMaster is closed. */
    control_persist_ms: ms(600_000),
    /** Channels on the one connection; sshd's MaxSessions defaults to 10. */
    max_channels: z.number().int().min(1).max(9).default(8),
  }),
  remote_root: z
    .string()
    .regex(REMOTE_PATH)
    .refine(
      (p) => p !== "/" && !p.endsWith("/") && !p.split("/").includes(".."),
      "remote_root must be a normalized directory other than /",
    ),
  /** PATH for the programs a session runs in the container: the image's, not the Mac's. */
  env_path: z
    .string()
    .regex(/^\/[A-Za-z0-9._/-]*(?::\/[A-Za-z0-9._/-]*)*$/)
    .default("/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"),
  /** A tag or an image id; never pulled (`--pull never`). `frm executor image` sets it. */
  image: z.string().regex(IMAGE_REF),
  /** What `frm executor image` builds FROM: a tag or id already on the docker host, resolved to
   * its id and used read-only (never pulled, tagged or removed). Trixie, not bookworm:
   * bookworm ships git 2.39.5 and backports the CVE-2025-48384 fix under that same version number,
   * which no version string can tell from an unpatched one, so a bookworm base can never clear the
   * submodule floor (§3.6). `frm executor image` reads the built image's git and checks it. */
  base_image: z.string().regex(IMAGE_REF).default("node:22-trixie-slim"),
  /** The network sessions join. Anything but `none` gets the gateway: the network is
   * then created `internal: true` with this executor's labels, or must already be exactly that. */
  network: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/)
    .default("none"),
  /** The gateway's ports on the internal network: socat to the /mcp tunnel, and tinyproxy. */
  gateway: z
    .object({ mcp_port: port(3010), proxy_port: port(8888) })
    .prefault({}),
  /** Hosts the gateway allows beside the runners' own `egressHosts`. */
  egress_allow: z.array(z.string().regex(EGRESS_HOST)).default([]),
  /** Tightens the fleet's executor.clock_skew_max_ms for this executor (§6.1); absent: the fleet's
   * setting alone. A larger value never loosens it. */
  clock_skew_max_ms: z.number().int().positive().optional(),
  /** How long health reuses its scan for this executor's build leftovers: the scan
   * reads the history of every dangling image on the shared host, seconds of docker calls. */
  leftover_scan_ms: ms(600_000),
  /** Cross-milestone rule 6: 4 CPUs, 3 GB, 512 pids per container; fsize caps one file. */
  limits: z
    .object({
      cpus: z.number().positive().max(64).default(4),
      memory: z
        .string()
        .regex(/^[1-9]\d*[kmg]$/)
        .default("3g"),
      pids: z.number().int().positive().default(512),
      fsize_bytes: z
        .number()
        .int()
        .positive()
        .default(2 * 1024 ** 3),
    })
    .prefault({}),
  min_free_pct: z.number().min(0).max(100).default(15),
  quota_gb: z.number().positive().default(15),
  /** One bound per method, matching the conformance suite's `call_timeout:<method>`. */
  timeouts: z
    .object({
      prepare_ms: ms(60_000),
      exec_ms: ms(15_000),
      probe_ms: ms(15_000),
      cleanup_ms: ms(15_000),
      close_ms: ms(5_000),
      /** The whole health check, every round trip and the disk usage included. */
      health_ms: ms(30_000),
      /** `frm executor image`: apt and the runners' installs run inside it. */
      build_ms: ms(1_800_000),
    })
    .prefault({}),
  heartbeat_ms: ms(5_000),
  deadman_ms: ms(30_000),
  kill_grace_ms: ms(5_000),
  /** Stdin credit: at most this much program input is ever in flight. */
  window_bytes: z
    .number()
    .int()
    .min(1024)
    .max(1024 * 1024)
    .default(256 * 1024),
});
export type ContainerExecutorConfig = z.infer<typeof ContainerExecutorConfig>;
export type ContainerExecutorConfigInput = z.input<
  typeof ContainerExecutorConfig
>;
