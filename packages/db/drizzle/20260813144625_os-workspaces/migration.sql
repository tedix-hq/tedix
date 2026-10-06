CREATE TABLE `os_blueprint_revisions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`blueprint_id` text NOT NULL,
	`revision` integer NOT NULL,
	`definition` text NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`published_at` text,
	CONSTRAINT `fk_os_blueprint_revisions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_os_blueprint_revisions_blueprint_id_os_blueprints_id_fk` FOREIGN KEY (`blueprint_id`) REFERENCES `os_blueprints`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `os_blueprints` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'draft' NOT NULL,
	`current_revision_id` text,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_os_blueprints_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `os_gadget_revisions` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`gadget_id` text NOT NULL,
	`revision` integer NOT NULL,
	`manifest` text NOT NULL,
	`source_artifact_ref` text,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_os_gadget_revisions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_os_gadget_revisions_gadget_id_os_gadgets_id_fk` FOREIGN KEY (`gadget_id`) REFERENCES `os_gadgets`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `os_gadgets` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`current_revision_id` text,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_os_gadgets_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_os_gadgets_workspace_id_os_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `os_workspaces`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `os_workspaces` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_os_workspaces_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `os_blueprint_revisions_blueprint_revision_unique` ON `os_blueprint_revisions` (`blueprint_id`,`revision`);--> statement-breakpoint
CREATE INDEX `os_blueprint_revisions_org_idx` ON `os_blueprint_revisions` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_blueprints_org_name_unique` ON `os_blueprints` (`organization_id`,`name`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_gadget_revisions_gadget_revision_unique` ON `os_gadget_revisions` (`gadget_id`,`revision`);--> statement-breakpoint
CREATE INDEX `os_gadget_revisions_org_idx` ON `os_gadget_revisions` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_gadgets_workspace_name_unique` ON `os_gadgets` (`workspace_id`,`name`);--> statement-breakpoint
CREATE INDEX `os_gadgets_org_idx` ON `os_gadgets` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_workspaces_org_name_unique` ON `os_workspaces` (`organization_id`,`name`);