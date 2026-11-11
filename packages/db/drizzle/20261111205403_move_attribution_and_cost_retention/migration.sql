-- Apply logs migration 0010 to every logs partition and rotate the writer
-- before releasing this activation. Moves still require verified D1 and R2 copies.
UPDATE `d1_retention_policies`
SET `mode` = 'move_to_logs_db', `updated_at` = CURRENT_TIMESTAMP
WHERE `table_name` = 'external_agent_attributions';
--> statement-breakpoint
INSERT INTO `d1_retention_policies` (`table_name`, `mode`, `keep_days`, `max_rows_per_run`)
VALUES ('tedi_call_costs', 'move_to_logs_db', 400, 5000)
ON CONFLICT (`table_name`) DO UPDATE SET
  `mode` = 'move_to_logs_db', `updated_at` = CURRENT_TIMESTAMP;
