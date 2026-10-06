CREATE TABLE `platform_cron_executions` (
	`id` text PRIMARY KEY,
	`schedule_id` text NOT NULL,
	`cron` text NOT NULL,
	`scheduled_at` text NOT NULL,
	`started_at` text NOT NULL,
	`finished_at` text,
	`status` text DEFAULT 'running' NOT NULL,
	`duration_ms` integer,
	`affected_row_counts` text DEFAULT '{}' NOT NULL,
	`error` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_platform_cron_executions_fire` ON `platform_cron_executions` (`schedule_id`,`scheduled_at`);--> statement-breakpoint
CREATE INDEX `idx_platform_cron_executions_schedule_started` ON `platform_cron_executions` (`schedule_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_platform_cron_executions_status_started` ON `platform_cron_executions` (`status`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_platform_cron_executions_created` ON `platform_cron_executions` (`created_at`);