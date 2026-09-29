-- 047_delivery_since: when a project's delivery was turned on.
--
-- Turning delivery on made every ticket already at a deliverable status due on the next sweep: a
-- push and a pull request for each finished ticket of the project's history. Delivery now applies
-- only to the moments a ticket reaches at or after this mark (the sweep reads the time it entered
-- its moment from ticket_events, never tickets.updated_at), and to deliveries begun at or after it
-- (deliveries.started_at, which every attempt rewrites).
--
--   workspaces.delivery_since  epoch ms at which delivery_mode last left 'none'; NULL while the
--             project delivers nothing. Moving between 'push' and 'pull_request', or to another
--             moment, keeps it; 'none' clears it, and turning delivery on again sets a new one.
--             The API writes it (Invariant 5), in the same transaction as the mode.
--
-- A project that already delivers is marked with this migration's own time — or earlier: the
-- oldest started_at among its deliveries still in flight, so none of them is stranded by the new
-- rule. In flight is what the supervisor's delivery job (its `finished` check) would still work on,
-- read from the row alone:
--   'failed'                               every one is retried;
--   'pushed' with no pr_url, in a          the pull request its mode asks for is not open yet (a
--      'pull_request' project               host with no forge also stops here: counted, the safe side).
-- Finished, and so no reason to reach back: 'pr_open', 'merged', 'closed' (each has its pull
-- request), and 'pushed' in a 'push' project. Every ticket at a deliverable status was due on every
-- pass before this migration, so an earlier mark delivers nothing that was not already due.
-- min(…, now) keeps a row stamped by a clock ahead of SQLite's from moving the mark past now.
--
-- No CHECK tying it to delivery_mode: SQLite tests an added column's CHECK against the rows already
-- here, which is exactly the rows this backfill is for. The read is fail-safe instead — a mark that
-- is NULL compares true with nothing, so such a project delivers nothing new.
ALTER TABLE workspaces ADD COLUMN delivery_since INTEGER;

UPDATE workspaces SET delivery_since = min(
    coalesce(
      (SELECT min(d.started_at) FROM deliveries d
         JOIN tickets t ON t.id = d.ticket_id
         WHERE t.workspace_id = workspaces.id
           AND (d.state = 'failed'
                OR (d.state = 'pushed' AND d.pr_url IS NULL
                    AND workspaces.delivery_mode = 'pull_request'))),
      CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER)),
    CAST(unixepoch('now', 'subsec') * 1000 AS INTEGER))
  WHERE delivery_mode <> 'none';
