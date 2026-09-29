# claude-sdk fixtures: HAND-AUTHORED

Every `.jsonl` file here was written by hand from the `@anthropic-ai/claude-agent-sdk` **0.3.269** typings
(`sdk.d.ts`, `sdk-tools.d.ts`; bundled CLI 2.1.269). None was recorded from a live runner: no API key existed yet.

- Each file starts with a `{"type":"fixture_meta","hand_authored":true,…}` line. It is not a runner record, so the
  tests drop it before mapping.
- Every other line is one stdout record of the runner in `stream-json` mode, as the raw log keeps it.
- `crash-zeroed.jsonl` ends in a partial line on purpose: the process died mid-write.

The mapper tests (`src/adapters/claude-sdk/mapper.test.ts`) assert a golden kind sequence per file, the mapper laws
L1–L5, replay determinism, and that every line matches the frame schemas in `frames.ts`.

## Re-recording

`FRM_REAL_RUNNER=1 FRM_RECORD=1 pnpm vitest run packages/runners/src/adapters/claude-sdk/live.test.ts` writes the
live stdout to `recorded/` (gitignored). The recorder fails if the API key's value appears in the output. Promote a
recording into this folder by hand, after review, and update its golden sequence; drop the `hand_authored` marker
only on recorded files.
