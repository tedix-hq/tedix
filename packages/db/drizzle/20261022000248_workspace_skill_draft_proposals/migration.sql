CREATE TABLE IF NOT EXISTS `os_workspace_skill_draft_proposals` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`member_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`base_content` text NOT NULL,
	`base_files` text,
	`content` text NOT NULL,
	`files` text,
	`reason` text NOT NULL,
	`payload_digest` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`withdrawn_at` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `os_workspace_skill_draft_proposals_target_idx` ON `os_workspace_skill_draft_proposals` (`organization_id`,`workspace_id`,`resource_id`,`created_at`);