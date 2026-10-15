CREATE TABLE `mcp_event_subscriptions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`owner_subject` text NOT NULL,
	`mcp_url` text NOT NULL,
	`event_name` text NOT NULL,
	`arguments` text NOT NULL,
	`callback_url` text NOT NULL,
	`sealed_credential` text NOT NULL,
	`cursor` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`consecutive_failures` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`rate_window_started_at` text,
	`rate_window_count` integer DEFAULT 0 NOT NULL,
	`last_delivered_at` text,
	`last_status` integer,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_mcp_event_subscriptions_due` ON `mcp_event_subscriptions` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_mcp_event_subscriptions_org_owner` ON `mcp_event_subscriptions` (`organization_id`,`owner_subject`);