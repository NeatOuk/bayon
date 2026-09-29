-- Reverts 039_push_url: every repo pushes to its origin_url again. Nothing on any remote is touched,
-- and the `deliveries` rows keep the hosts they recorded.
ALTER TABLE deliveries DROP COLUMN remote_url;
ALTER TABLE repos DROP COLUMN push_url;
