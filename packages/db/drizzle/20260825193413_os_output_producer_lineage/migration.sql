ALTER TABLE `os_output_revisions` ADD `skill_run_id` text;--> statement-breakpoint
ALTER TABLE `os_output_revisions` ADD `skill_id` text;--> statement-breakpoint
CREATE INDEX `os_output_revisions_skill_run_idx` ON `os_output_revisions` (`skill_run_id`,`created_at`);