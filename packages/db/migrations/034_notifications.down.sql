-- Reverts 034_notifications: the outbox, its deliveries and watermarks go, and the notifier's
-- seeded settings with them. Children first, for the foreign key.
DROP TABLE notification_deliveries;
DROP TABLE notification_cursors;
DROP TABLE notifications;
DELETE FROM settings WHERE key IN (
  'notify.poll_ms',
  'notify.mac.enabled', 'notify.mac.events',
  'notify.ntfy.enabled', 'notify.ntfy.events',
  'notify.webhook.enabled', 'notify.webhook.events',
  'notify.email.enabled', 'notify.email.events',
  'notify.quiet_start_hour', 'notify.quiet_end_hour',
  'notify.email.to', 'notify.email.from', 'notify.base_url'
);
