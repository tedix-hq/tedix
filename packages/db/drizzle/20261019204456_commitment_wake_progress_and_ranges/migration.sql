CREATE TABLE `platform_cron_checkpoints` (
	`schedule_id` text PRIMARY KEY,
	`through` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_os_gadget_executions_completed` ON `os_gadget_executions` (`completed_at`);--> statement-breakpoint
CREATE INDEX `idx_work_items_deadline` ON `work_items` (`deadline`);--> statement-breakpoint
CREATE INDEX `idx_work_items_due_date` ON `work_items` (`due_date`);--> statement-breakpoint
CREATE INDEX `idx_work_approval_resolved` ON `work_approval_proposals` (`resolved_at`);--> statement-breakpoint
CREATE INDEX `idx_work_interaction_responses_time` ON `work_interaction_responses` (`responded_at`);--> statement-breakpoint
CREATE INDEX `idx_work_interactions_due` ON `work_interactions` (`due_at`);--> statement-breakpoint
CREATE INDEX `idx_approval_requests_resolved` ON `tedi_approval_requests` (`resolved_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_runs_completed` ON `skill_runs` (`completed_at`);