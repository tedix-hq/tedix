CREATE INDEX `idx_tedi_usage_events_created` ON `tedi_usage_events` (`created_at`);
--> statement-breakpoint
CREATE INDEX `workflow_run_ledger_started_idx` ON `workflow_run_ledger` (`started_at`);
--> statement-breakpoint
-- Logs migration 0016 adds the three tables; the nightly cleanup stops
-- deleting them in the same release.
INSERT INTO `d1_retention_policies` (`table_name`, `mode`, `keep_days`, `max_rows_per_run`)
VALUES ('tedi_usage_events', 'move_to_logs_db', 30, 5000),
  ('widget_events', 'move_to_logs_db', 30, 5000),
  ('workflow_run_ledger', 'move_to_logs_db', 90, 5000)
ON CONFLICT (`table_name`) DO NOTHING;
