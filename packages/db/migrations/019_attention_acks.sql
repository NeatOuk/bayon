-- 019_attention_acks (M4): the operator's dismissal of a finished session's error.
--
-- The Fleet attention strip mixed two different things: live conditions the operator can still fix,
-- and post-mortem facts about sessions that are already over. The second kind sat there for
-- ERRORED_WITHIN_MS (24 h) with no way to clear it, which trains the operator to ignore the strip.
--
-- Only an error exit is acknowledgeable, so the key is the session alone: an exited session's
-- `why` can never change, and there is exactly one error exit per session to dismiss. A stale
-- session is a live condition that clears itself on its next event or when it is stopped —
-- acknowledging one "for good" would hide something still true and still actionable, which is a
-- worse dead end than the one this fixes. The schema cannot express that, by design.
--
-- API-owned (§9.5): the operator dismisses through REST, so the supervisor never writes here.
CREATE TABLE attention_acks (
  session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  acked_at INTEGER NOT NULL,
  -- Who dismissed it, as audit_log records the same act.
  acked_by TEXT NOT NULL
);
