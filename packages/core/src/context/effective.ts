// Whether a session's model calls go through the context proxy (spec M12, §5.1): the project turned
// it on, the adapter declares support, the executor is local (the proxy runs beside the
// supervisor), and the session is not MCP-only (it has no runner tools whose output to compress).

export interface CompressionFacts {
  readonly projectOn: boolean;
  readonly adapterSupports: boolean;
  readonly executorLocal: boolean;
  readonly mcpOnly: boolean;
}

export const effectiveCompression = (f: CompressionFacts): boolean =>
  f.projectOn && f.adapterSupports && f.executorLocal && !f.mcpOnly;
