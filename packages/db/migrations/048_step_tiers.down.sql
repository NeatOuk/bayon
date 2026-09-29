-- 048_step_tiers down: 047's `workspaces`. The three columns go, last first; each carries only its
-- own CHECK, which SQLite drops with it. A project's step tiers are lost: its sessions inherit again,
-- as every session did before 048.
ALTER TABLE workspaces DROP COLUMN review_tier;
ALTER TABLE workspaces DROP COLUMN build_tier;
ALTER TABLE workspaces DROP COLUMN plan_tier;
