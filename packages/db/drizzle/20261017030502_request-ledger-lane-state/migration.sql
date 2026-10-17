ALTER TABLE `agent_session_requests` ADD `lane_running` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `agent_session_requests` ADD `last_reflected_at` text;