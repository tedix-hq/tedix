CREATE TABLE `agent_session_events` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`harness` text NOT NULL,
	`session_key` text NOT NULL,
	`repository` text,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`activity` text,
	`source_at` text NOT NULL,
	`source_key` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claimed_at` text,
	`processed_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_agent_session_events_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `agent_session_requests` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`harness` text NOT NULL,
	`session_key` text NOT NULL,
	`repository` text,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	`status` text NOT NULL,
	`evidence` text,
	`turns_unaddressed` integer DEFAULT 0 NOT NULL,
	`source_at` text NOT NULL,
	`source_key` text NOT NULL,
	`status_changed_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_agent_session_requests_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_session_events_org_user_source` ON `agent_session_events` (`organization_id`,`user_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `idx_agent_session_events_org_user_status` ON `agent_session_events` (`organization_id`,`user_id`,`status`,`source_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_session_requests_org_user_source` ON `agent_session_requests` (`organization_id`,`user_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `idx_agent_session_requests_org_user_status` ON `agent_session_requests` (`organization_id`,`user_id`,`status`,`source_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_session_requests_org_user_session` ON `agent_session_requests` (`organization_id`,`user_id`,`harness`,`session_key`);