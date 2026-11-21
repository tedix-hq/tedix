CREATE INDEX `idx_call_costs_execution` ON `tedi_call_costs` (`provider_execution_id`);--> statement-breakpoint
CREATE INDEX `idx_billing_usage_quarantine_created` ON `billing_usage_quarantines` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_site_reconciliation_runs_completed` ON `site_reconciliation_runs` (`completed_at`);--> statement-breakpoint
CREATE INDEX `idx_provider_execution_authorized` ON `provider_execution_attempts` (`authorized_at`);
--> statement-breakpoint
-- Logs migration 0019 must be applied before the retention policies run.
INSERT INTO `d1_retention_policies` (`table_name`, `mode`, `keep_days`, `max_rows_per_run`)
VALUES ('provider_execution_attempts', 'move_to_logs_db', 90, 500),
  ('billing_usage_quarantines', 'move_to_logs_db', 90, 500),
  ('site_reconciliation_runs', 'move_to_logs_db', 7, 500)
ON CONFLICT (`table_name`) DO NOTHING;
