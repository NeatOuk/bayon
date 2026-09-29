-- Reverts 002_seed. Fails with a foreign-key error while a session still uses a seeded run class.
DELETE FROM settings WHERE key IN (
  'retention.reasoning', 'retention.events_days', 'retention.qa_video_days', 'autosplit.enabled',
  'autosplit.handoff_threshold', 'autosplit.max_children', 'autosplit.max_depth',
  'roles.require_distinct_reviewer', 'budget.daily_cap_usd'
);
DELETE FROM run_classes
WHERE name IN ('pulse', 'spike', 'build', 'build_complex', 'review', 'fix', 'qa', 'probe');
