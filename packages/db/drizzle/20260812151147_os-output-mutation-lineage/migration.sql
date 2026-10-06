CREATE TABLE `os_output_mutation_receipts` (
	`id` text PRIMARY KEY,
	`instance_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`gadget_id` integer NOT NULL,
	`operation` text NOT NULL,
	`output_kind` text NOT NULL,
	`revision` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`idempotent` integer DEFAULT false NOT NULL,
	`artifact_ref` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_session_id` text,
	`tedi_id` text,
	`work_item_id` text,
	`skill_run_id` text,
	`skill_id` text,
	`workflow_step_id` text,
	`workflow_step_name` text,
	`workflow_call_id` text,
	`kernel_run_id` text,
	`trace_bundle_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_os_output_mutation_receipts_instance_id_os_instances_id_fk` FOREIGN KEY (`instance_id`) REFERENCES `os_instances`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `skill_runs` ADD `work_item_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `os_output_mutation_receipts_idempotency_unique` ON `os_output_mutation_receipts` (`instance_id`,`workspace_id`,`gadget_id`,`operation`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `os_output_mutation_receipts_instance_created_idx` ON `os_output_mutation_receipts` (`instance_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `os_output_mutation_receipts_work_item_idx` ON `os_output_mutation_receipts` (`work_item_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `os_output_mutation_receipts_skill_run_idx` ON `os_output_mutation_receipts` (`skill_run_id`,`created_at`);