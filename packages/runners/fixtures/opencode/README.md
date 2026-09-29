# opencode fixtures

Each `.jsonl` file is one turn host's stdout for the `opencode` runner (design `the design`): the
`opencode acp` lines (newline-delimited JSON-RPC 2.0) relayed byte for byte, and the host's own frames
(`frm.host.start`, `frm.host.turn`, `frm.host.output`, `frm.host.interrupt`, `frm.host.exit`) between them. The first
line of every file is a `{"type":"fixture_meta",…}` line. It is not a record, so the tests drop it before mapping.

## Recorded (`"recorded": true`)

Taken from real `opencode acp` 1.18.32 sessions against an Ollama host, then scrubbed:

- the worktree path is `/work/repo`; no home path, host address or token is left (the scrubber refuses to write a
  file that still holds one);
- the host's frames were added by hand at the places the host writes them: the spike drove opencode with a bare ACP
  client, so the frames are the only lines not recorded;
- very long streams of `agent_message_chunk`/`agent_thought_chunk` keep the first six chunks of each message; the
  meta line says how many were elided.

| File                 | What it shows                                                                                            |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `plain-turn`         | `initialize`, `session/new`, one text reply, `end_turn` with usage                                       |
| `write-and-wander`   | a `write` tool call (pending → in_progress → completed), then the model wandering: Ollama's 4096 context |
| `cancel-then-ok`     | `session/cancel` during `sleep`: the tool reports "User aborted", the prompt answers `cancelled`         |
| `resume-new-process` | `session/resume` in a new process, then a turn (no replayed history)                                     |
| `mcp-then-deny`      | a `foreman_conformance_echo` MCP call, then a `bash` call the permission config denies                   |
| `prompt-error`       | an unreachable provider: the prompt answers a JSON-RPC `-32603` error (`errorName: APIError`)            |
| `model-not-found`    | `session/set_config_option` refuses an unknown model (`-32602`); the host ends the session               |

The models' odd behaviour in `write-and-wander` and `resume-new-process` is real: the Ollama host ran every model at
its default 4096-token context, which opencode's own prompt nearly fills (spike fact 15).

## Hand-authored (`"hand_authored": true`)

Written from the opencode 1.18.32 sources (`acp/tool.ts`, `tool/edit.ts`, `tool/shell.ts`, `acp/permission.ts`) and
the host's frames, for shapes the live models did not produce:

- `edit-and-bash`: an `edit` with its `filediff` line counts, a `bash` command with `exit: 0`, a `todowrite`;
- `structured-review` / `structured-invalid`: the host's `frm.host.output` check, valid and not;
- `crash-no-terminal`: opencode dies mid-tool, so there is no prompt response and no terminal;
- `permission-asked`: a rule that fell through to `ask`, which the host refused;
- `partial-line`: ends in a cut-off line with no newline, on purpose.

## Re-recording

`FRM_REAL_RUNNER=1 FRM_OLLAMA_BASE_URL=http://<ollama-host>:11434/v1 FRM_RECORD=1 pnpm exec vitest run
packages/runners/src/adapters/opencode/live.test.ts` writes the host's stdout to `recorded/` (gitignored). Scrub a
recording (paths, addresses, ids you mind) before promoting it here by hand, and update its golden sequence.
