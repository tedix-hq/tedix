-- Shorter main-database windows for two append-only tables. Moves still
-- copy to LOGS_DB and R2 and verify before deleting; pins are unchanged
-- except that platform call costs (no organization) may now move.
UPDATE `d1_retention_policies`
SET `keep_days` = 7, `updated_at` = CURRENT_TIMESTAMP
WHERE `table_name` = 'external_agent_attributions';
--> statement-breakpoint
UPDATE `d1_retention_policies`
SET `keep_days` = 90, `updated_at` = CURRENT_TIMESTAMP
WHERE `table_name` = 'tedi_call_costs';
