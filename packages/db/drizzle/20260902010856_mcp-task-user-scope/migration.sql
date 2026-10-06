ALTER TABLE `mcp_tasks` ADD `subject_user_id` text;--> statement-breakpoint
UPDATE `mcp_tasks`
SET `subject_user_id` = json_extract(`input_requests`, '$.caller.userId')
WHERE `subject_user_id` IS NULL
  AND json_type(`input_requests`, '$.caller.userId') = 'text';--> statement-breakpoint
CREATE INDEX `idx_mcp_tasks_org_subject_user` ON `mcp_tasks` (`org_id`,`subject_user_id`);
