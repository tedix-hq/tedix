CREATE TABLE `tenant_behavioral_eval_case_attempts` (
	`id` text PRIMARY KEY,
	`case_run_id` text NOT NULL,
	`attempt_number` integer NOT NULL,
	`home_run_id` text NOT NULL,
	`status` text NOT NULL,
	`disposition` text NOT NULL,
	`error` text,
	`event_cursor` integer NOT NULL,
	`terminal_status` text,
	`selected_route` text,
	`effects_suppressed` integer,
	`execution_receipt` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_tenant_behavioral_eval_case_attempts_case_run_id_tenant_behavioral_eval_case_runs_id_fk` FOREIGN KEY (`case_run_id`) REFERENCES `tenant_behavioral_eval_case_runs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `tenant_behavioral_eval_case_runs` ADD `attempt_number` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tbe_case_attempt_number` ON `tenant_behavioral_eval_case_attempts` (`case_run_id`,`attempt_number`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tbe_case_attempt_home` ON `tenant_behavioral_eval_case_attempts` (`home_run_id`);