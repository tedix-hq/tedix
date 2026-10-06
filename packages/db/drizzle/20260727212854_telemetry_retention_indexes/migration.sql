CREATE INDEX `idx_learning_interaction_events_created` ON `learning_interaction_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_org_timestamp` ON `audit_events` (`organization_id`,`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_audit_events_timestamp` ON `audit_events` (`timestamp`);--> statement-breakpoint
CREATE INDEX `idx_skill_usage_events_created` ON `skill_usage_events` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_cron_executions_created` ON `tedi_cron_executions` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_harness_eval_results_created` ON `harness_eval_results` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_harness_eval_runs_created` ON `harness_eval_runs` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_trace_bundles_created` ON `trace_bundles` (`created_at`);--> statement-breakpoint
CREATE INDEX `idx_runtime_submissions_created` ON `runtime_submissions` (`created_at`);