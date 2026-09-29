// The exporter's fixed identity (design doc §2): main.ts's wiring, the `export.run` claimer
// handler, the interval scheduler and whoever seeds the fleet config (tools/frm today, an operator
// flow later) all need to agree on these ids -- one place, so they never drift apart.
export const EXPORTER_RUNNER_ID = "script-export-markdown";
export const EXPORTER_AGENT_ID = "exporter";
export const EXPORTER_RUN_CLASS = "export";
export const EXPORTER_ROLE = "util";
/** Its run's prompt. A session spawned without one starts no run, and the job waits for `go`. */
export const EXPORTER_PROMPT = "Export every ticket and mission to markdown.";
