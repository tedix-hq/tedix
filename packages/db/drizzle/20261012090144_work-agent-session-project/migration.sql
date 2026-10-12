ALTER TABLE `work_agent_sessions` ADD `project_id` text;--> statement-breakpoint
ALTER TABLE `work_agent_sessions` ADD `work_item_id` text;--> statement-breakpoint
CREATE INDEX `idx_work_agent_sessions_org_project` ON `work_agent_sessions` (`organization_id`,`project_id`);