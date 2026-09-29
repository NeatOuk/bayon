-- 048_step_tiers: a model tier per step of a project's work (§8.4, §9.8).
--
-- A step is a group of run classes (core RUN_CLASS_STEP): plan (`spike`), build (`build`,
-- `build_complex`, `fix`) and review (`review`, which every LLM gate's session runs). A project may
-- name a tier for each; NULL (every project already here) inherits, which is what every session did
-- before. At spawn a session's tier is its role binding's `model_tier`, else its project's for its
-- step, else its profile's (core sessionTier). Written only by the API (`PATCH /projects/:id`,
-- audited `project.set`, and `POST /projects`), Invariant 5.
--
-- Three columns, each with a CHECK that names only itself, so the down migration drops them one by
-- one and 047's `workspaces` text comes back as it was.
ALTER TABLE workspaces ADD COLUMN plan_tier TEXT
  CHECK (plan_tier IN ('complex', 'standard', 'cheap'));
ALTER TABLE workspaces ADD COLUMN build_tier TEXT
  CHECK (build_tier IN ('complex', 'standard', 'cheap'));
ALTER TABLE workspaces ADD COLUMN review_tier TEXT
  CHECK (review_tier IN ('complex', 'standard', 'cheap'));
