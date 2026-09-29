-- 031_project_timeline (M5): a project's history timeline, read at request time.
--
--   audit_log.workspace_id  the project an audit row is about, stamped by insertAudit in the writer's
--               own transaction (API and supervisor alike). A plain column, no REFERENCES: the log
--               outlives what it names, and SQLite's DROP COLUMN refuses a column in a foreign key.
--               Resolved from the row's target first; else from its actor `session:<id>`; else NULL
--               (operator config, a supervisor act on an unscoped target). A session's project is
--               its own workspace, else its agent's. repos/audit-scope.ts is the same rules in
--               TypeScript; migrate-031.test.ts checks the two agree.
--   the backfill  fills the rows already there with those rules. Only a row whose target kind or
--               actor can resolve is touched.
--   audit_log_workspace_ts_idx   a project's audit rows by time: the timeline's audit source.
--   ticket_events_ts_idx         ticket history by time: the timeline's ticket source.
--   sessions_agent_created_idx   an agent's sessions newest first (GET /agents/:id/sessions): on
--               created_at, which every session has; a queued one has no started_at yet.
--   human_requests_session_idx   a session's requests: the timeline scopes a request with no ticket
--               through its session.
ALTER TABLE audit_log ADD COLUMN workspace_id TEXT;

UPDATE audit_log SET workspace_id = coalesce(
  CASE target_kind
    WHEN 'ticket' THEN
      (SELECT t.workspace_id FROM tickets t WHERE t.id = audit_log.target_id)
    WHEN 'project' THEN
      (SELECT w.id FROM workspaces w WHERE w.id = audit_log.target_id)
    WHEN 'agent' THEN
      (SELECT a.workspace_id FROM agents a WHERE a.id = audit_log.target_id)
    WHEN 'session' THEN
      (SELECT coalesce(s.workspace_id, a.workspace_id)
         FROM sessions s JOIN agents a ON a.id = s.agent_id
        WHERE s.id = audit_log.target_id)
    WHEN 'human_request' THEN
      (SELECT coalesce(t.workspace_id, s.workspace_id, a.workspace_id)
         FROM human_requests h
         LEFT JOIN tickets t ON t.id = h.ticket_id
         LEFT JOIN sessions s ON s.id = h.session_id
         LEFT JOIN agents a ON a.id = s.agent_id
        WHERE h.id = audit_log.target_id)
    WHEN 'pulse' THEN
      (SELECT a.workspace_id FROM pulses p JOIN agents a ON a.id = p.agent_id
        WHERE p.id = audit_log.target_id)
    WHEN 'finding' THEN
      (SELECT t.workspace_id
         FROM findings f JOIN gates g ON g.id = f.gate_id JOIN tickets t ON t.id = g.ticket_id
        WHERE f.id = audit_log.target_id)
  END,
  CASE WHEN instr(actor, 'session:') = 1 THEN
    (SELECT coalesce(s.workspace_id, a.workspace_id)
       FROM sessions s JOIN agents a ON a.id = s.agent_id
      WHERE s.id = substr(audit_log.actor, 9))
  END
)
WHERE target_kind IN ('ticket', 'project', 'agent', 'session', 'human_request', 'pulse', 'finding')
   OR instr(actor, 'session:') = 1;

CREATE INDEX audit_log_workspace_ts_idx ON audit_log(workspace_id, ts, id);
CREATE INDEX ticket_events_ts_idx ON ticket_events(ts, id);
CREATE INDEX sessions_agent_created_idx ON sessions(agent_id, created_at);
CREATE INDEX human_requests_session_idx ON human_requests(session_id);
