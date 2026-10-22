CREATE TABLE IF NOT EXISTS `os_workspace_skill_draft_grants` (
	`organization_id` text NOT NULL,
	`member_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`enabled` integer NOT NULL,
	`expires_at` text NOT NULL,
	`granted_by` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `os_workspace_skill_draft_grants_pk` PRIMARY KEY(`organization_id`, `member_id`, `workspace_id`, `resource_id`)
);
