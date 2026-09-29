-- 006_tool_call_index: the tool-call counter pairs a `command` with its session's
-- `tool_call` by call id, so one call a runner reports as both counts once. Partial: only
-- tool_call rows are indexed. The CASE keeps a malformed payload storable (Invariant 4): a bare
-- json_extract would raise on it at insert.
CREATE INDEX events_tool_call_idx
  ON events(
    session_id,
    (CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.call_id') END)
  )
  WHERE kind = 'tool_call';
