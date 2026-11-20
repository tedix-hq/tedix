CREATE INDEX `kernel_request_events_created_idx` ON `kernel_request_events` (`created_at`);
--> statement-breakpoint
-- Logs migration 0015 adds both tables to every logs database before this
-- release's api deploys. Moves copy and verify before removing a main row.
INSERT INTO `d1_retention_policies` (`table_name`, `mode`, `keep_days`, `max_rows_per_run`)
VALUES ('kernel_request_events', 'move_to_logs_db', 30, 5000),
  ('platform_cron_executions', 'move_to_logs_db', 90, 5000)
ON CONFLICT (`table_name`) DO NOTHING;
