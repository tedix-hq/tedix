ALTER TABLE `skill_entries` ADD `folder_path` text;--> statement-breakpoint
CREATE INDEX `idx_skill_entries_org_folder` ON `skill_entries` (`organization_id`,`folder_path`);