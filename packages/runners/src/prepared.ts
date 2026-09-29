// The spec as its executor's programs reach the world, one implementation for
// the spawn pipeline and the conformance suite: the API's /mcp at the URL the executor
// prepared (a container's gateway), and its egress proxy in the env, with the gateway itself exempt.
// An executor that prepares neither leaves the spec as it is. Runner-neutral.
import type { Prepared } from "@bayon/executors";
import type { SpawnSpec } from "./adapter.js";

const hostOf = (url: string | undefined): string[] => {
  if (url === undefined) return [];
  try {
    return [new URL(url).hostname];
  } catch {
    return [];
  }
};

export function applyPrepared(spec: SpawnSpec, prepared: Prepared): SpawnSpec {
  const mcp =
    spec.mcp !== undefined && prepared.mcpUrl !== undefined
      ? { ...spec.mcp, url: prepared.mcpUrl }
      : spec.mcp;
  const proxy = prepared.proxyUrl;
  const exempt = [
    ...new Set(["localhost", "127.0.0.1", ...hostOf(prepared.mcpUrl)]),
  ].join(",");
  const env =
    proxy === undefined
      ? spec.env
      : {
          ...spec.env,
          HTTPS_PROXY: proxy,
          HTTP_PROXY: proxy,
          https_proxy: proxy,
          http_proxy: proxy,
          NO_PROXY: exempt,
          no_proxy: exempt,
        };
  return { ...spec, env, ...(mcp === undefined ? {} : { mcp }) };
}
