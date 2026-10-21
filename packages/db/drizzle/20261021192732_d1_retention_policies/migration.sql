CREATE TABLE `d1_retention_policies` (
	`table_name` text PRIMARY KEY,
	`mode` text DEFAULT 'off' NOT NULL,
	`keep_days` integer NOT NULL,
	`max_rows_per_run` integer DEFAULT 2000 NOT NULL,
	`last_run_at` text,
	`last_report` text,
	`archived_rows_total` integer DEFAULT 0 NOT NULL,
	`deleted_rows_total` integer DEFAULT 0 NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
-- Every policy starts in dry_run: hourly runs report what they would archive
-- and free, and change no rows. Switching a table to archive_then_delete is a
-- separate, reviewed change.
INSERT OR IGNORE INTO `d1_retention_policies` (`table_name`, `mode`, `keep_days`, `max_rows_per_run`) VALUES
	('audit_events', 'dry_run', 14, 10000),
	('tedi_runtime_events', 'dry_run', 14, 10000),
	('kernel_runtime_events', 'dry_run', 14, 5000),
	('skill_run_artifacts', 'dry_run', 14, 5000);
