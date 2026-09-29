-- 023_gate_round (M4): which review round opened a gate.
--
-- `attempt` is per kind and counts up forever, so it cannot say whether THIS round opened a gate of
-- a kind — only whether one ever existed on the ticket. That is the hole guard left and
-- the one `ce_review` has had since M3: turn a conditional gate off, take request_fix and resubmit,
-- turn it back on, and `pass_review` is satisfied by the earlier round's passed gate, against a
-- workspace or a diff that has moved on since.
--
-- A round is the batch one planRound call opens: every gate it opens shares `1 + max(round)` over
-- the ticket's gates. A rerun (POST /gates/:id/run) and decideGate's timeout retry stay in their
-- round and carry the round of the gate they follow, so neither counts as a new review.
--
-- Backfill: DEFAULT 1 for every existing row, so a ticket that already has gates behaves exactly as
-- it does today (one round, every gate in it) and the first round opened after this migration gets
-- 2. Backfilling from `attempt` would be wrong -- a retry or a rerun bumps `attempt` without
-- opening a round, so the kinds of one round would disagree about its number.
ALTER TABLE gates ADD COLUMN round INTEGER NOT NULL DEFAULT 1;

-- The laws ask "is there a gate of this kind in the ticket's current round", and the writers ask
-- for the ticket's highest round. Both are (ticket_id, round) lookups.
CREATE INDEX IF NOT EXISTS gates_round_idx ON gates(ticket_id, round);
