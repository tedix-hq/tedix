-- tedix: destructive-reviewed Work-Item: 923f1d5f-2cbd-4e30-a910-615de697d9bd
-- Raises the bound on a machine tool call's stored input from 4,000 to 220,000
-- characters, so a call can carry the content of a file to write. The rebuild
-- copies every row; no table references machine_tool_calls.
CREATE TABLE `__new_machine_tool_calls` (
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
	CONSTRAINT "chk_machine_tool_calls_bounds" CHECK(length("input") <= 220000
				AND ("result" IS NULL OR length("result") <= 20000)
				AND ("error" IS NULL OR length("error") <= 1000))
);
--> statement-breakpoint
INSERT INTO `__new_machine_tool_calls`(`id`, `org_id`, `machine_name`, `tool`, `input`, `requested_by_type`, `requested_by_id`, `status`, `result`, `error`, `claimed_by_reporter_id`, `created_at`, `claimed_at`, `finished_at`, `expires_at`) SELECT `id`, `org_id`, `machine_name`, `tool`, `input`, `requested_by_type`, `requested_by_id`, `status`, `result`, `error`, `claimed_by_reporter_id`, `created_at`, `claimed_at`, `finished_at`, `expires_at` FROM `machine_tool_calls`;--> statement-breakpoint
DROP TABLE `machine_tool_calls`;--> statement-breakpoint
ALTER TABLE `__new_machine_tool_calls` RENAME TO `machine_tool_calls`;--> statement-breakpoint
CREATE INDEX `idx_machine_tool_calls_machine_status` ON `machine_tool_calls` (`org_id`,`machine_name`,`status`,`created_at`);