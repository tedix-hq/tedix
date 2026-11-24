ALTER TABLE `agent_session_events` ADD `body_r2_key` text;--> statement-breakpoint
ALTER TABLE `agent_session_events` ADD `has_activity` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_session_events` ADD `body_archived_at` text;--> statement-breakpoint
CREATE INDEX `idx_agent_session_events_body_retention` ON `agent_session_events` (`processed_at`,`id`) WHERE status = 'processed' AND body_archived_at IS NULL;