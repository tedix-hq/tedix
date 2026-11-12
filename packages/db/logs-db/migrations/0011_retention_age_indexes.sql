-- Keep shared log-table indexes in parity with the main schema.
CREATE INDEX idx_external_agent_attribution_occurred ON external_agent_attributions (occurred_at);
CREATE INDEX idx_call_costs_created ON tedi_call_costs (created_at);
CREATE INDEX idx_skill_run_artifacts_created ON skill_run_artifacts (created_at);
