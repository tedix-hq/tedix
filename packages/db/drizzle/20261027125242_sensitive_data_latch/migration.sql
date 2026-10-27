ALTER TABLE `app_tools` ADD `sensitive_data` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `app_tools` ADD `public_egress` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `skill_runs` ADD `sensitive_data_latch` text;--> statement-breakpoint
ALTER TABLE `kernel_runtime_runs` ADD `sensitive_data_latch` text;--> statement-breakpoint
UPDATE `app_tools`
SET `public_egress` = 1
WHERE `tool_id` = 'content_publish'
	OR `tool_id` LIKE '%\_\_content_publish' ESCAPE '\';
