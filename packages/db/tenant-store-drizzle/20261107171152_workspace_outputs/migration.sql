CREATE TABLE `os_output_revisions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`output_id` text NOT NULL,
	`revision` integer NOT NULL,
	`content` text NOT NULL,
	`note` text,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`skill_run_id` text,
	`skill_id` text,
	`access_envelope` text,
	`content_sha256` text,
	`content_bytes` integer,
	`body_r2_key` text,
	CONSTRAINT `fk_os_output_revisions_output_id_os_outputs_id_fk` FOREIGN KEY (`output_id`) REFERENCES `os_outputs`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `os_outputs` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`workspace_id` text,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`current_revision_id` text,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `os_workspaces` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`source_blueprint_id` text,
	`source_blueprint_revision_id` text,
	`source_blueprint_revision_number` integer,
	`instantiation_preflight` text,
	`previous_blueprint_revision_id` text,
	`previous_blueprint_revision_number` integer,
	`previous_instantiation_preflight` text,
	`blueprint_decision` text,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`visibility` text DEFAULT 'org' NOT NULL,
	`owner_user_id` text,
	`icon_url` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `os_output_revisions_output_revision_unique` ON `os_output_revisions` (`output_id`,`revision`);--> statement-breakpoint
CREATE INDEX `os_output_revisions_org_idx` ON `os_output_revisions` (`organization_id`);--> statement-breakpoint
CREATE INDEX `os_output_revisions_skill_run_idx` ON `os_output_revisions` (`skill_run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `os_outputs_org_idx` ON `os_outputs` (`organization_id`,`updated_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_workspaces_org_id_unique` ON `os_workspaces` (`organization_id`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_workspaces_org_name_unique` ON `os_workspaces` (`organization_id`,`name`);