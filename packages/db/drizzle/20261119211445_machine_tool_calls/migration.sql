CREATE TABLE `machine_tool_calls` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`machine_name` text NOT NULL,
	`tool` text NOT NULL,
	`input` text NOT NULL,
	`requested_by_type` text NOT NULL,
	`requested_by_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`result` text,
	`error` text,
	`claimed_by_reporter_id` text,
	`created_at` text NOT NULL,
	`claimed_at` text,
	`finished_at` text,
	`expires_at` text NOT NULL,
	CONSTRAINT `fk_machine_tool_calls_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_machine_tool_calls_bounds" CHECK(length("input") <= 4000
				AND ("result" IS NULL OR length("result") <= 20000)
				AND ("error" IS NULL OR length("error") <= 1000))
);
--> statement-breakpoint
ALTER TABLE `dispatcher_health_reports` ADD `machine_name` text;--> statement-breakpoint
ALTER TABLE `dispatcher_health_reports` ADD `machine_tools` text;--> statement-breakpoint
ALTER TABLE `dispatcher_health_reports` ADD `reported_by` text;--> statement-breakpoint
CREATE INDEX `idx_machine_tool_calls_machine_status` ON `machine_tool_calls` (`org_id`,`machine_name`,`status`,`created_at`);