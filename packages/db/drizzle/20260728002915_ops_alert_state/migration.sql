CREATE TABLE `ops_alert_state` (
	`condition_key` text PRIMARY KEY,
	`severity` text NOT NULL,
	`metric_bucket` text DEFAULT '0' NOT NULL,
	`detail` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_notified_at` text,
	`notify_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ops_alert_state_status` ON `ops_alert_state` (`status`);