// A session's context proxy, as an adapter starts it (spec M12): the refusals every compressing
// adapter shares, then the proxy and the frame sink its records join. Runner-neutral; the adapter
// brings its provider's transform and upstream.
import {
  CONTEXT_RULESET,
  err,
  ok,
  type FrmError,
  type Result,
} from "@bayon/core";
import type { Executor } from "@bayon/executors";
import type { SpawnSpec } from "./adapter.js";
import { createFrameSink, type FrameSink } from "./context-frames.js";
import type { ContextTransform } from "./context-rewrite.js";
import { storeProblem } from "./context-store.js";
import { frmError } from "./errors.js";
import {
  startModelProxy,
  type ProxyLog,
  type ProxyTrace,
} from "./model-proxy.js";

/** A running proxy and where its frames go. */
export interface SessionProxy {
  readonly url: string;
  readonly port: number;
  readonly token: string;
  readonly frames: FrameSink;
  close(): Promise<void>;
}

/**
 * Env names that route a process's HTTP through a proxy. The context proxy connects upstream
 * directly, so it could not honour one: a session that names one is refused rather than quietly
 * sent another way.
 */
const EGRESS_PROXIES = [
  "HTTPS_PROXY",
  "https_proxy",
  "HTTP_PROXY",
  "http_proxy",
  "ALL_PROXY",
  "all_proxy",
];

/** An adapter's own declaration (RunnerAdapter.compressesContext): the one place support lives. */
export type CompressesContext = (ex: Pick<Executor, "kind">) => boolean;

/** The roots a session writes: its worktree, its extra roots, its home. The store is none of them. */
export const writableRoots = (spec: SpawnSpec): readonly string[] => [
  spec.cwd,
  ...(spec.extraRoots ?? []),
  spec.homeDir,
];

/**
 * Why `spec`'s compression cannot run on `ex`; null when it can (or is off). `compresses` is the
 * adapter's declaration, so what it declares is what is enforced.
 */
export function compressionRefusal(
  spec: SpawnSpec,
  ex: Pick<Executor, "kind">,
  compresses: CompressesContext,
): FrmError | null {
  const c = spec.contextCompression;
  if (c === undefined) return null;
  if (!compresses(ex)) {
    return frmError(
      "validation",
      `this runner does not compress context on a ${ex.kind} executor`,
    );
  }
  if (c.ruleset !== CONTEXT_RULESET) {
    return frmError(
      "validation",
      `context ruleset ${JSON.stringify(c.ruleset)} is not this build's (${CONTEXT_RULESET})`,
    );
  }
  const proxied = EGRESS_PROXIES.filter(
    (name) => (spec.env[name] ?? "") !== "",
  );
  if (proxied.length > 0) {
    return frmError(
      "validation",
      `context compression cannot honour the session's egress proxy (${proxied.join(", ")}): its proxy connects upstream directly`,
    );
  }
  const misplaced = storeProblem(c.storeDir, writableRoots(spec));
  return misplaced === null
    ? null
    : frmError("validation", `context compression: ${misplaced}`);
}

/** The warning a proxy event becomes, as the adapters report theirs (e.g. FrmStructuredOutput). */
export const CONTEXT_PROXY_WARNING = "FrmContextProxy";

/** One process warning per event: fixed words and a code, never a header, body or URL. */
const warningLog =
  (sessionId: string): ProxyLog =>
  (event, detail) => {
    process.emitWarning(
      `session ${sessionId}: ${event}${detail === undefined ? "" : ` (${detail})`}`,
      CONTEXT_PROXY_WARNING,
    );
  };

/**
 * Starts `spec`'s proxy when compression is on: ok(undefined) when it is off. Refusals are
 * `validation`; a proxy that cannot listen is `spawn_failed` (retryable), so a session never starts
 * uncompressed by accident.
 */
export async function startSessionProxy(
  spec: SpawnSpec,
  ex: Pick<Executor, "kind">,
  o: {
    readonly compresses: CompressesContext;
    readonly transform: ContextTransform;
    readonly upstream: string;
    readonly log?: ProxyLog;
    /** The proxy's debug trace (model-proxy.ts); by default `NODE_DEBUG=frmproxy`. */
    readonly trace?: ProxyTrace;
  },
): Promise<Result<SessionProxy | undefined>> {
  const c = spec.contextCompression;
  if (c === undefined) return ok(undefined);
  const refused = compressionRefusal(spec, ex, o.compresses);
  if (refused !== null) return err(refused);
  const frames = createFrameSink();
  const started = await startModelProxy({
    upstream: o.upstream,
    token: c.token,
    transform: o.transform,
    onFrame: (f) => frames.push(f),
    storeDir: c.storeDir,
    writable: writableRoots(spec),
    log: o.log ?? warningLog(spec.sessionId),
    ...(o.trace === undefined ? {} : { trace: o.trace }),
  });
  if (!started.ok) return started;
  const proxy = started.value;
  return ok({
    url: proxy.url,
    port: proxy.port,
    token: c.token,
    frames,
    close: () => proxy.close(),
  });
}
