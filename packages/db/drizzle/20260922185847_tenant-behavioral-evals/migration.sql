CREATE TABLE `tenant_behavioral_eval_assertion_results` (
	`id` text PRIMARY KEY,
	`case_run_id` text NOT NULL,
	`assertion_index` integer NOT NULL,
	`type` text NOT NULL,
	`passed` integer NOT NULL,
	`detail` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tenant_behavioral_eval_case_runs` (
	`id` text PRIMARY KEY,
	`run_id` text NOT NULL,
	`case_id` text NOT NULL,
	`home_run_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`event_cursor` integer DEFAULT 0 NOT NULL,
	`saw_closed` integer DEFAULT false NOT NULL,
	`drained` integer DEFAULT false NOT NULL,
	`terminal_status` text,
	`selected_route` text,
	`effects_suppressed` integer,
	`error` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tenant_behavioral_eval_definitions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tenant_behavioral_eval_revisions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`definition_id` text NOT NULL,
	`revision` integer NOT NULL,
	`spec` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tenant_behavioral_eval_runs` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`definition_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`idempotency_key` text NOT NULL,
	`payload_digest` text NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`passed` integer,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tbe_assertion_result` ON `tenant_behavioral_eval_assertion_results` (`case_run_id`,`assertion_index`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tbe_case_run` ON `tenant_behavioral_eval_case_runs` (`run_id`,`case_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tbe_home_run` ON `tenant_behavioral_eval_case_runs` (`home_run_id`);--> statement-breakpoint
CREATE INDEX `idx_tbe_definitions_org` ON `tenant_behavioral_eval_definitions` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tbe_revision_number` ON `tenant_behavioral_eval_revisions` (`definition_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_tbe_revisions_org_definition` ON `tenant_behavioral_eval_revisions` (`organization_id`,`definition_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tbe_run_idempotency` ON `tenant_behavioral_eval_runs` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_tbe_runs_org` ON `tenant_behavioral_eval_runs` (`organization_id`,`created_at`);