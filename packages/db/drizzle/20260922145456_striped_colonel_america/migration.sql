ALTER TABLE `workstation_leases` ADD `attempt_id` text;--> statement-breakpoint
ALTER TABLE `workstation_leases` ADD `repository_path` text;--> statement-breakpoint
ALTER TABLE `workstation_leases` ADD `repo_start_sha` text;--> statement-breakpoint
ALTER TABLE `workstation_leases` ADD `prepared_start_sha` text;--> statement-breakpoint
CREATE INDEX `idx_workstation_leases_attempt` ON `workstation_leases` (`attempt_id`);