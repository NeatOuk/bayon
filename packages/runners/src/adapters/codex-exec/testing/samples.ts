// A shell result over the §8.5 cap as the turn host's stdout carries it, for the supervisor's
// runner-neutral cap test (Invariant 9), reached through `@bayon/runners/testing`. Tests only.
const encoder = new TextEncoder();

/** 500 lines: over the tool-result cap of 200 lines, so ingest must spill it. */
export const LONG_OUTPUT = `${Array.from(
  { length: 500 },
  (_, i) => `line ${i + 1}`,
).join("\n")}\n`;

const command = {
  id: "item_1",
  type: "command_execution",
  command: "/bin/zsh -lc 'seq -f \"line %g\" 1 500'",
};

/** The host's start and turn frames, then one command's started and completed items. */
export const CODEX_TOOL_OUTPUT = {
  output: LONG_OUTPUT,
  records: [
    {
      type: "frm.host.start",
      v: 1,
      runner_session_id: "rsid-sample",
      thread_id: null,
      usage_total: null,
    },
    {
      type: "frm.host.turn",
      run_id: "run-1",
      model: "gpt-5.6-luna",
      resume: false,
      argv: ["codex", "exec", "--json", "-"],
    },
    { type: "thread.started", thread_id: "thr-sample" },
    {
      type: "item.started",
      item: {
        ...command,
        aggregated_output: "",
        exit_code: null,
        status: "in_progress",
      },
    },
    {
      type: "item.completed",
      item: {
        ...command,
        aggregated_output: LONG_OUTPUT,
        exit_code: 0,
        status: "completed",
      },
    },
  ].map((record) => encoder.encode(JSON.stringify(record))),
} as const;
