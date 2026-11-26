-- tedix: destructive-reviewed Work-Item: 661f1d64-d601-4371-8fca-a8cc375753c1
-- Preserve every event column and copy rowid to sequence without renumbering
-- existing snapshot cursors. No table references agent_session_events; the
-- rebuild preserves its organization FK and recreates every existing index.
CREATE TABLE `__new_agent_session_events` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL UNIQUE,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`harness` text NOT NULL,
	`session_key` text NOT NULL,
	`repository` text,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`body_r2_key` text,
	`has_activity` integer DEFAULT false NOT NULL,
	`body_archived_at` text,
	`activity` text,
	`source_at` text NOT NULL,
	`source_key` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`claimed_at` text,
	`processed_at` text,
	`lesson_reflection` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_agent_session_events_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_agent_session_events`(`sequence`, `id`, `organization_id`, `user_id`, `harness`, `session_key`, `repository`, `kind`, `body`, `body_r2_key`, `has_activity`, `body_archived_at`, `activity`, `source_at`, `source_key`, `status`, `attempts`, `claimed_at`, `processed_at`, `lesson_reflection`, `created_at`) SELECT `rowid`, `id`, `organization_id`, `user_id`, `harness`, `session_key`, `repository`, `kind`, `body`, `body_r2_key`, `has_activity`, `body_archived_at`, `activity`, `source_at`, `source_key`, `status`, `attempts`, `claimed_at`, `processed_at`, `lesson_reflection`, `created_at` FROM `agent_session_events`;--> statement-breakpoint
DROP TABLE `agent_session_events`;--> statement-breakpoint
ALTER TABLE `__new_agent_session_events` RENAME TO `agent_session_events`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_agent_session_events_org_user_source` ON `agent_session_events` (`organization_id`,`user_id`,`source_key`);--> statement-breakpoint
CREATE INDEX `idx_agent_session_events_org_user_sequence` ON `agent_session_events` (`organization_id`,`user_id`,`sequence`);--> statement-breakpoint
CREATE INDEX `idx_agent_session_events_org_user_status` ON `agent_session_events` (`organization_id`,`user_id`,`status`,`source_at`);--> statement-breakpoint
CREATE INDEX `idx_agent_session_events_org_user_source_at` ON `agent_session_events` (`organization_id`,`user_id`,`source_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_agent_session_events_session_order` ON `agent_session_events` (`organization_id`,`user_id`,`harness`,`session_key`,`status`,`source_at`,`id`);--> statement-breakpoint
CREATE INDEX `idx_agent_session_events_session_kind_order` ON `agent_session_events` (`organization_id`,`user_id`,`harness`,`session_key`,`kind`,`source_at`,`source_key`);--> statement-breakpoint
CREATE INDEX `idx_agent_session_events_body_retention` ON `agent_session_events` (`processed_at`,`id`) WHERE status = 'processed' AND body_archived_at IS NULL;--> statement-breakpoint
CREATE INDEX `idx_agent_session_events_body_backfill` ON `agent_session_events` (`processed_at`,`id`) WHERE status = 'processed' AND body_archived_at IS NULL AND body_r2_key IS NULL;--> statement-breakpoint
CREATE INDEX `idx_agent_session_events_pending_heads` ON `agent_session_events` (`organization_id`,`user_id`,`status`,`harness`,`session_key`,`source_at`,`id`);
--> statement-breakpoint
CREATE TRIGGER agent_session_events_sequence_immutable
BEFORE UPDATE ON agent_session_events
WHEN NEW.sequence <> OLD.sequence
BEGIN
  SELECT RAISE(ABORT, 'agent_session_events.sequence is immutable');
END;
