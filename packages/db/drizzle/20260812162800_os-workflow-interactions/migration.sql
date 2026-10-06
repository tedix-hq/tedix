CREATE TABLE `os_workflow_interactions` (
	`id` text PRIMARY KEY,
	`instance_id` text NOT NULL,
	`workspace_id` text,
	`gadget_id` integer,
	`kind` text NOT NULL,
	`event_type` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`fingerprint` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`output_receipt_id` text,
	`output_kind` text,
	`output_revision` text,
	`artifact_ref` text,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_session_id` text,
	`tedi_id` text NOT NULL,
	`skill_run_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`execution_epoch` integer NOT NULL,
	`error` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`delivered_at` text,
	CONSTRAINT `fk_os_workflow_interactions_instance_id_os_instances_id_fk` FOREIGN KEY (`instance_id`) REFERENCES `os_instances`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_os_workflow_interactions_output_receipt_id_os_output_mutation_receipts_id_fk` FOREIGN KEY (`output_receipt_id`) REFERENCES `os_output_mutation_receipts`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `os_workflow_interactions_idempotency_unique` ON `os_workflow_interactions` (`instance_id`,`skill_run_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `os_workflow_interactions_instance_created_idx` ON `os_workflow_interactions` (`instance_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `os_workflow_interactions_work_item_idx` ON `os_workflow_interactions` (`work_item_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `os_workflow_interactions_skill_run_idx` ON `os_workflow_interactions` (`skill_run_id`,`created_at`);