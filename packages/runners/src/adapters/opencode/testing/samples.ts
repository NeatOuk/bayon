// A shell result over the §8.5 cap as the turn host's stdout carries it, for the supervisor's
// runner-neutral cap test (Invariant 9), reached through `@bayon/runners/testing`. Tests only.
const encoder = new TextEncoder();

/** 500 lines: over the tool-result cap of 200 lines, so ingest must spill it. */
export const LONG_OUTPUT = `${Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n")}\n`;

const SESSION = "ses_sample";
const COMMAND = 'seq -f "line %g" 1 500';
const update = (u: Readonly<Record<string, unknown>>) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: SESSION, update: u },
});

/** The host's start and turn frames, then one bash call's pending, running and completed updates. */
export const OPENCODE_TOOL_OUTPUT = {
  output: LONG_OUTPUT,
  records: [
    {
      type: "frm.host.start",
      v: 1,
      runner_session_id: SESSION,
      resumed: false,
      model: "ollama/sample",
    },
    {
      type: "frm.host.turn",
      run_id: "run-1",
      rpc_id: 4,
      model: "ollama/sample",
      output: false,
    },
    update({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      title: "bash",
      kind: "execute",
      status: "pending",
      locations: [],
      rawInput: {},
    }),
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "in_progress",
      kind: "execute",
      title: COMMAND,
      locations: [],
      rawInput: { command: COMMAND },
    }),
    update({
      sessionUpdate: "tool_call_update",
      toolCallId: "call_1",
      status: "completed",
      content: [
        { type: "content", content: { type: "text", text: LONG_OUTPUT } },
      ],
      rawOutput: {
        output: LONG_OUTPUT,
        metadata: { output: LONG_OUTPUT, exit: 0, truncated: false },
      },
    }),
  ].map((record) => encoder.encode(JSON.stringify(record))),
} as const;
