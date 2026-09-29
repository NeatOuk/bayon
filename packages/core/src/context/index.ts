// Context compression's pure rules (spec M12; the design): the proxy of each
// runner adapter calls these on large tool results; nothing here reads the wire, a clock or a file.
export * from "./constants.js";
export type {
  Compression,
  CompressOptions,
  UnchangedReason,
} from "./compress.js";
export { compressToolResult, needsCompression } from "./compress.js";
export type { CompressionFacts } from "./effective.js";
export { effectiveCompression } from "./effective.js";
export {
  CONTEXT_FRAME_TYPE,
  ContextFrame,
  ContextTotals,
  MAX_FRAME_DIGESTS,
  foldContextFrame,
  parseContextFrame,
} from "./frame.js";
export { isUnifiedDiff, mentionsContextStore } from "./guards.js";
export type { ContextRule, MarkerFacts } from "./marker.js";
export { CONTEXT_RULES, contextMarker, isMarkerPath } from "./marker.js";
