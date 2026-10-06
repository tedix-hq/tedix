PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tenant_behavioral_eval_assertion_results` (
	`id` text PRIMARY KEY,
	`case_run_id` text NOT NULL,
	`assertion_index` integer NOT NULL,
	`type` text NOT NULL,
	`passed` integer NOT NULL,
	`detail` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_tenant_behavioral_eval_assertion_results_case_run_id_tenant_behavioral_eval_case_runs_id_fk` FOREIGN KEY (`case_run_id`) REFERENCES `tenant_behavioral_eval_case_runs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_tenant_behavioral_eval_assertion_results`(`id`, `case_run_id`, `assertion_index`, `type`, `passed`, `detail`, `created_at`) SELECT `id`, `case_run_id`, `assertion_index`, `type`, `passed`, `detail`, `created_at` FROM `tenant_behavioral_eval_assertion_results`;--> statement-breakpoint
DROP TABLE `tenant_behavioral_eval_assertion_results`;--> statement-breakpoint
ALTER TABLE `__new_tenant_behavioral_eval_assertion_results` RENAME TO `tenant_behavioral_eval_assertion_results`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tenant_behavioral_eval_case_runs` (
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
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_tenant_behavioral_eval_case_runs_run_id_tenant_behavioral_eval_runs_id_fk` FOREIGN KEY (`run_id`) REFERENCES `tenant_behavioral_eval_runs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_tenant_behavioral_eval_case_runs`(`id`, `run_id`, `case_id`, `home_run_id`, `status`, `event_cursor`, `saw_closed`, `drained`, `terminal_status`, `selected_route`, `effects_suppressed`, `error`, `created_at`, `updated_at`) SELECT `id`, `run_id`, `case_id`, `home_run_id`, `status`, `event_cursor`, `saw_closed`, `drained`, `terminal_status`, `selected_route`, `effects_suppressed`, `error`, `created_at`, `updated_at` FROM `tenant_behavioral_eval_case_runs`;--> statement-breakpoint
DROP TABLE `tenant_behavioral_eval_case_runs`;--> statement-breakpoint
ALTER TABLE `__new_tenant_behavioral_eval_case_runs` RENAME TO `tenant_behavioral_eval_case_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tenant_behavioral_eval_definitions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`name` text NOT NULL,
	`latest_revision` integer DEFAULT 1 NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_tenant_behavioral_eval_definitions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tenant_behavioral_eval_definitions_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
INSERT INTO `__new_tenant_behavioral_eval_definitions`(`id`, `organization_id`, `tedi_id`, `name`, `latest_revision`, `created_at`) SELECT `id`, `organization_id`, `tedi_id`, `name`, `latest_revision`, `created_at` FROM `tenant_behavioral_eval_definitions`;--> statement-breakpoint
DROP TABLE `tenant_behavioral_eval_definitions`;--> statement-breakpoint
ALTER TABLE `__new_tenant_behavioral_eval_definitions` RENAME TO `tenant_behavioral_eval_definitions`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tbe_definitions_id_org` ON `tenant_behavioral_eval_definitions` (`id`,`organization_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tenant_behavioral_eval_revisions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`definition_id` text NOT NULL,
	`revision` integer NOT NULL,
	`spec` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_tenant_behavioral_eval_revisions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tenant_behavioral_eval_revisions_definition_id_tenant_behavioral_eval_definitions_id_fk` FOREIGN KEY (`definition_id`) REFERENCES `tenant_behavioral_eval_definitions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tbe_revision_definition_org` FOREIGN KEY (`definition_id`,`organization_id`) REFERENCES `tenant_behavioral_eval_definitions`(`id`,`organization_id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_tenant_behavioral_eval_revisions`(`id`, `organization_id`, `definition_id`, `revision`, `spec`, `created_at`) SELECT `id`, `organization_id`, `definition_id`, `revision`, `spec`, `created_at` FROM `tenant_behavioral_eval_revisions`;--> statement-breakpoint
DROP TABLE `tenant_behavioral_eval_revisions`;--> statement-breakpoint
ALTER TABLE `__new_tenant_behavioral_eval_revisions` RENAME TO `tenant_behavioral_eval_revisions`;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tbe_revisions_id_org` ON `tenant_behavioral_eval_revisions` (`id`,`organization_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_tenant_behavioral_eval_runs` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`definition_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	`idempotency_key` text NOT NULL,
	`payload_digest` text NOT NULL,
	`lease_token` text,
	`lease_until` text,
	`passed` integer,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_tenant_behavioral_eval_runs_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tenant_behavioral_eval_runs_definition_id_tenant_behavioral_eval_definitions_id_fk` FOREIGN KEY (`definition_id`) REFERENCES `tenant_behavioral_eval_definitions`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tenant_behavioral_eval_runs_revision_id_tenant_behavioral_eval_revisions_id_fk` FOREIGN KEY (`revision_id`) REFERENCES `tenant_behavioral_eval_revisions`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_tenant_behavioral_eval_runs_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_tbe_run_definition_org` FOREIGN KEY (`definition_id`,`organization_id`) REFERENCES `tenant_behavioral_eval_definitions`(`id`,`organization_id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tbe_run_revision_org` FOREIGN KEY (`revision_id`,`organization_id`) REFERENCES `tenant_behavioral_eval_revisions`(`id`,`organization_id`) ON DELETE RESTRICT
);
--> statement-breakpoint
INSERT INTO `__new_tenant_behavioral_eval_runs`(`id`, `organization_id`, `definition_id`, `revision_id`, `tedi_id`, `status`, `version`, `idempotency_key`, `payload_digest`, `lease_token`, `lease_until`, `passed`, `created_at`, `updated_at`) SELECT `id`, `organization_id`, `definition_id`, `revision_id`, `tedi_id`, `status`, `version`, `idempotency_key`, `payload_digest`, `lease_token`, `lease_until`, `passed`, `created_at`, `updated_at` FROM `tenant_behavioral_eval_runs`;--> statement-breakpoint
DROP TABLE `tenant_behavioral_eval_runs`;--> statement-breakpoint
ALTER TABLE `__new_tenant_behavioral_eval_runs` RENAME TO `tenant_behavioral_eval_runs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tbe_assertion_result` ON `tenant_behavioral_eval_assertion_results` (`case_run_id`,`assertion_index`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tbe_case_run` ON `tenant_behavioral_eval_case_runs` (`run_id`,`case_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tbe_home_run` ON `tenant_behavioral_eval_case_runs` (`home_run_id`);--> statement-breakpoint
CREATE INDEX `idx_tbe_definitions_org` ON `tenant_behavioral_eval_definitions` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tbe_revision_number` ON `tenant_behavioral_eval_revisions` (`definition_id`,`revision`);--> statement-breakpoint
CREATE INDEX `idx_tbe_revisions_org_definition` ON `tenant_behavioral_eval_revisions` (`organization_id`,`definition_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_tbe_run_idempotency` ON `tenant_behavioral_eval_runs` (`organization_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_tbe_runs_org` ON `tenant_behavioral_eval_runs` (`organization_id`,`created_at`);
