-- Reverts 004_pulse. Drops the pulse tables and all their data: dev and test only (the CLI wants
-- --yes). v_needs_attention goes back to 003's text byte for byte, the M2 settings rows go, and
-- the tables go children first, since with foreign_keys=ON each DROP deletes its rows first.
DROP VIEW v_needs_attention;
CREATE VIEW v_needs_attention AS
  SELECT 'stale_session' AS why, s.id AS ref, s.ticket_id FROM sessions s
    WHERE s.state IN ('running','idle') AND s.last_event_at < unixepoch()*1000 - 1800000
  UNION ALL SELECT 'handoff_pending', h.id, h.ticket_id FROM handoffs h
    WHERE h.to_session_id IS NULL
  UNION ALL SELECT 'unstaffed_ready', t.id, t.id FROM tickets t
    WHERE t.status='prioritized' AND t.owner_session_id IS NULL
  UNION ALL SELECT 'gate_stuck', g.id, g.ticket_id FROM gates g
    WHERE g.state='failed' OR (g.state='running' AND g.started_at < unixepoch()*1000 - 900000)
  UNION ALL SELECT DISTINCT 'findings_open', f.gate_id, g.ticket_id FROM findings f
    JOIN gates g ON g.id=f.gate_id WHERE f.status='open' AND f.severity IN ('blocker','major')
  UNION ALL SELECT 'unanswered_human', h.id, h.ticket_id FROM human_requests h
    WHERE h.status='open' AND h.asked_at < unixepoch()*1000 - 86400000
  UNION ALL SELECT 'unread_message', m.id, m.ticket_id FROM messages m
    WHERE m.to_kind='agent' AND m.read_at IS NULL
  UNION ALL SELECT 'export_failed', e.target, e.ticket_id FROM ticket_exports e
    WHERE e.state='failed';
DELETE FROM settings WHERE key IN (
  'pulse.lease_ttl_ms', 'handoff.max_turns', 'handoff.wall_clock_ms', 'handoff.prompt_tokens_cap',
  'handoff.packet_tokens_cap', 'preflight.margin_pct', 'spend.alarm_pct', 'spend.baseline_days'
);
DROP TABLE pulse_checks;
DROP TABLE pulses;
DROP TABLE probes;
