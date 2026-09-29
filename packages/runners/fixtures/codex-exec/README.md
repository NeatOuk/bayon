# codex-exec fixtures: HAND-AUTHORED

Every `.jsonl` file here was written by hand from `codex-rs/exec/src/exec_events.rs` at tag `rust-v0.154.0` (the
pinned Codex CLI) and the turn host's four frames (`frm.host.start`, `frm.host.turn`, `frm.host.interrupt`,
`frm.host.exit`). None was recorded from a live runner: no credential existed yet.

- Each file starts with a `{"type":"fixture_meta","hand_authored":true,…}` line. It is not a record, so the tests drop
  it before mapping.
- Every other line is one stdout record of the turn host, as the raw log keeps it: Codex's `exec --json` lines relayed
  byte for byte, and the host's own frames between them.
- `partial-line.jsonl` ends in a cut-off line on purpose: the host died mid-write.
- `interrupted.jsonl` has no Codex terminal: 0.154.0 prints nothing on `TurnStatus::Interrupted`. The mapper's
  `terminal{interrupted, basis: "interrupt+exit"}` comes from the host's interrupt and exit frames (§5.2 amendment).
- `review-hang.jsonl` and `crash-no-terminal.jsonl` must map to no terminal at all (§5.2 terminal rule).

The mapper tests (`src/adapters/codex-exec/mapper.test.ts`) assert a golden kind sequence per file and the mapper laws
L1–L5.

## Re-recording

`FRM_REAL_RUNNER=1 FRM_RECORD=1 pnpm vitest run packages/runners/src/adapters/codex-exec/live.test.ts` writes the
host's live stdout to `recorded/` (gitignored). The recorder fails if the API key's value appears in the output.
Promote a recording into this folder by hand, after review, and update its golden sequence; drop the `hand_authored`
marker only on recorded files.
