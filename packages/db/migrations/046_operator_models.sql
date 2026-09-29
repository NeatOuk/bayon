-- 046_operator_models: models the operator manages (§4: config over code).
--   * source: 'adapter' (written by a registration at supervisor boot) or 'operator' (frm config
--     apply, or the REST door). Boot writes adapter rows only: it never overwrites, retires or
--     deactivates an operator row, and it leaves its own row of a tier inactive while an operator
--     row is active there. Every existing row is an adapter's.
--   * settings_json: the row's own settings for its runner's adapter, which alone validates and
--     reads them (Invariant 1). Never a secret (§14).
-- Prices and context_tokens exist since 001. models_tier_idx (one active row per runner and tier)
-- is unchanged.
ALTER TABLE models ADD COLUMN source TEXT NOT NULL DEFAULT 'adapter'
  CHECK (source IN ('adapter', 'operator'));
ALTER TABLE models ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';
