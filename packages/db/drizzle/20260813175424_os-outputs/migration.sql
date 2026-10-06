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
	CONSTRAINT `fk_os_output_revisions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
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
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_os_outputs_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `os_output_revisions_output_revision_unique` ON `os_output_revisions` (`output_id`,`revision`);--> statement-breakpoint
CREATE INDEX `os_output_revisions_org_idx` ON `os_output_revisions` (`organization_id`);--> statement-breakpoint
CREATE INDEX `os_outputs_org_idx` ON `os_outputs` (`organization_id`,`updated_at`);