-- 030_staff_approval (M5): a project may require the operator's approval for its
-- orchestrator's staffing. With the switch on, `ticket_staff` from a session files a proposal -- a
-- human_requests row of kind `staff_approval` -- instead of starting anyone; the operator's answer
-- approves it (the proposed agent is staffed) or rejects it. The operator's own staffing never asks.
--
--   workspaces.staff_approval  1 while the project's orchestrator only proposes. A column beside 029's
--               `paused`, for the same reasons: it is read with its workspace, in the staffing
--               transaction. 0 for every workspace already there: nothing changes by the migration.
--               Written only by the API's PATCH /projects/:id, each change audited.
--   human_requests.proposal_json  what a `staff_approval` request proposes: {agent_id, runner_id,
--               role, run_class, handoff_id}. NULL on every other row.
--   human_requests_ticket_status_idx  a ticket's open requests: the pulse's no-op check and context
--               pack ask, per attention row, whether its ticket has an open proposal.
ALTER TABLE workspaces ADD COLUMN staff_approval INTEGER NOT NULL DEFAULT 0
  CHECK (staff_approval IN (0, 1));
ALTER TABLE human_requests ADD COLUMN proposal_json TEXT;
CREATE INDEX human_requests_ticket_status_idx ON human_requests(ticket_id, status);
