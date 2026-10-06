CREATE TABLE `work_agent_sessions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`harness` text NOT NULL,
	`session_key` text NOT NULL,
	`label` text DEFAULT '' NOT NULL,
	`state` text NOT NULL,
	`summary` text DEFAULT '' NOT NULL,
	`state_since` text NOT NULL,
	`last_event_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_work_agent_sessions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_agent_sessions_org_user_harness_session` ON `work_agent_sessions` (`organization_id`,`user_id`,`harness`,`session_key`);--> statement-breakpoint
CREATE INDEX `idx_work_agent_sessions_org_user_last_event` ON `work_agent_sessions` (`organization_id`,`user_id`,`last_event_at`);