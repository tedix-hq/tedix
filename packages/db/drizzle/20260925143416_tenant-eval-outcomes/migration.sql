ALTER TABLE `tenant_behavioral_eval_assertion_results` ADD `severity` text DEFAULT 'gate' NOT NULL;--> statement-breakpoint
ALTER TABLE `tenant_behavioral_eval_assertion_results` ADD `disposition` text;--> statement-breakpoint
ALTER TABLE `tenant_behavioral_eval_case_runs` ADD `disposition` text;--> statement-breakpoint
ALTER TABLE `tenant_behavioral_eval_runs` ADD `last_advance_error` text;--> statement-breakpoint
ALTER TABLE `tenant_behavioral_eval_runs` ADD `last_advance_error_phase` text;--> statement-breakpoint
ALTER TABLE `tenant_behavioral_eval_runs` ADD `last_advance_error_retryable` integer;