UPDATE `skill_runs` SET `runtime_environment` = 'production' WHERE `runtime_environment` IS NULL;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_skill_runs` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`skill_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`workflow_instance_id` text NOT NULL,
	`execution_epoch` integer DEFAULT 0 NOT NULL,
	`restart_requested_at` text,
	`restart_command_id` text,
	`workflow_retired_at` text,
	`runtime_environment` text NOT NULL,
	`last_reconciled_at` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`params` text,
	`result` text,
	`error` text,
	`capability_manifest` text,
	`cost_summary` text,
	`workflow_source` text,
	`skill_doc` text,
	`skill_revision` integer,
	`skill_slug` text,
	`started_at` text DEFAULT (CURRENT_TIMESTAMP),
	`completed_at` text,
	`paused_at` text,
	`created_by` text,
	`work_item_id` text,
	CONSTRAINT `fk_skill_runs_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_skill_runs_skill_id_skill_entries_id_fk` FOREIGN KEY (`skill_id`) REFERENCES `skill_entries`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_skill_runs_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_skill_runs`(`id`, `organization_id`, `skill_id`, `tedi_id`, `workflow_instance_id`, `execution_epoch`, `restart_requested_at`, `restart_command_id`, `workflow_retired_at`, `runtime_environment`, `last_reconciled_at`, `status`, `params`, `result`, `error`, `capability_manifest`, `cost_summary`, `workflow_source`, `skill_doc`, `skill_revision`, `skill_slug`, `started_at`, `completed_at`, `paused_at`, `created_by`, `work_item_id`) SELECT `id`, `organization_id`, `skill_id`, `tedi_id`, `workflow_instance_id`, `execution_epoch`, `restart_requested_at`, `restart_command_id`, `workflow_retired_at`, `runtime_environment`, `last_reconciled_at`, `status`, `params`, `result`, `error`, `capability_manifest`, `cost_summary`, `workflow_source`, `skill_doc`, `skill_revision`, `skill_slug`, `started_at`, `completed_at`, `paused_at`, `created_by`, `work_item_id` FROM `skill_runs`;--> statement-breakpoint
DROP TABLE `skill_runs`;--> statement-breakpoint
ALTER TABLE `__new_skill_runs` RENAME TO `skill_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_skill_runs_org_status` ON `skill_runs` (`organization_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_skill_runs_skill` ON `skill_runs` (`skill_id`);--> statement-breakpoint
CREATE INDEX `idx_skill_runs_tedi_started` ON `skill_runs` (`tedi_id`,`started_at`);--> statement-breakpoint
CREATE INDEX `idx_skill_runs_reconcile` ON `skill_runs` (`runtime_environment`,`last_reconciled_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_skill_runs_workflow_instance` ON `skill_runs` (`workflow_instance_id`);
