-- Reverts 047_delivery_since: 046's workspaces table. The sweep before 047 reads no mark, so a
-- delivering project goes back to delivering every ticket at a deliverable status.
ALTER TABLE workspaces DROP COLUMN delivery_since;
