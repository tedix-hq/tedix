CREATE TABLE `tedi_control_plane_binding_history` (
	`id` text PRIMARY KEY DEFAULT (lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )),
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`kind` text NOT NULL,
	`previous_revision_id` text,
	`revision_id` text NOT NULL,
	`changed_by` text,
	`change_reason` text,
	`effective_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_tedi_control_plane_binding_history_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_control_plane_binding_history_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `policy_packs` ADD `supersedes_revision_id` text REFERENCES policy_packs(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `policy_packs` ADD `rollback_of_revision_id` text REFERENCES policy_packs(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `policy_packs` ADD `change_summary` text;--> statement-breakpoint
ALTER TABLE `policy_packs` ADD `published_at` text;--> statement-breakpoint
ALTER TABLE `policy_packs` ADD `published_by` text;--> statement-breakpoint
ALTER TABLE `runtime_profiles` ADD `supersedes_revision_id` text REFERENCES runtime_profiles(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `runtime_profiles` ADD `rollback_of_revision_id` text REFERENCES runtime_profiles(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `runtime_profiles` ADD `change_summary` text;--> statement-breakpoint
ALTER TABLE `runtime_profiles` ADD `published_at` text;--> statement-breakpoint
ALTER TABLE `runtime_profiles` ADD `published_by` text;--> statement-breakpoint
ALTER TABLE `workspace_template_sets` ADD `supersedes_revision_id` text REFERENCES workspace_template_sets(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `workspace_template_sets` ADD `rollback_of_revision_id` text REFERENCES workspace_template_sets(id) ON DELETE RESTRICT;--> statement-breakpoint
ALTER TABLE `workspace_template_sets` ADD `change_summary` text;--> statement-breakpoint
ALTER TABLE `workspace_template_sets` ADD `published_at` text;--> statement-breakpoint
ALTER TABLE `workspace_template_sets` ADD `published_by` text;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_policy_packs` (
	`id` text PRIMARY KEY DEFAULT (lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )),
	`organization_id` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`scope` text DEFAULT 'organization' NOT NULL,
	`target` text DEFAULT 'shared' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`supersedes_revision_id` text,
	`rollback_of_revision_id` text,
	`change_summary` text,
	`published_at` text,
	`published_by` text,
	`definition` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_policy_packs_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_policy_packs_supersedes_revision_id_policy_packs_id_fk` FOREIGN KEY (`supersedes_revision_id`) REFERENCES `policy_packs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_policy_packs_rollback_of_revision_id_policy_packs_id_fk` FOREIGN KEY (`rollback_of_revision_id`) REFERENCES `policy_packs`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `uniq_policy_packs_scope_slug_version` UNIQUE(`scope`,`slug`,`version`)
);
--> statement-breakpoint
INSERT INTO `__new_policy_packs`(`id`, `organization_id`, `name`, `slug`, `description`, `scope`, `target`, `status`, `version`, `definition`, `created_at`, `updated_at`) SELECT `id`, `organization_id`, `name`, `slug`, `description`, `scope`, `target`, `status`, `version`, `definition`, `created_at`, `updated_at` FROM `policy_packs`;--> statement-breakpoint
DROP TABLE `policy_packs`;--> statement-breakpoint
ALTER TABLE `__new_policy_packs` RENAME TO `policy_packs`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_runtime_profiles` (
	`id` text PRIMARY KEY DEFAULT (lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )),
	`organization_id` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`scope` text DEFAULT 'organization' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`supersedes_revision_id` text,
	`rollback_of_revision_id` text,
	`change_summary` text,
	`published_at` text,
	`published_by` text,
	`config` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_runtime_profiles_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_runtime_profiles_supersedes_revision_id_runtime_profiles_id_fk` FOREIGN KEY (`supersedes_revision_id`) REFERENCES `runtime_profiles`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_runtime_profiles_rollback_of_revision_id_runtime_profiles_id_fk` FOREIGN KEY (`rollback_of_revision_id`) REFERENCES `runtime_profiles`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `uniq_runtime_profiles_scope_slug_version` UNIQUE(`scope`,`slug`,`version`)
);
--> statement-breakpoint
INSERT INTO `__new_runtime_profiles`(`id`, `organization_id`, `name`, `slug`, `description`, `scope`, `status`, `version`, `config`, `created_at`, `updated_at`) SELECT `id`, `organization_id`, `name`, `slug`, `description`, `scope`, `status`, `version`, `config`, `created_at`, `updated_at` FROM `runtime_profiles`;--> statement-breakpoint
DROP TABLE `runtime_profiles`;--> statement-breakpoint
ALTER TABLE `__new_runtime_profiles` RENAME TO `runtime_profiles`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_workspace_template_sets` (
	`id` text PRIMARY KEY DEFAULT (lower(
    hex(randomblob(4)) || '-' ||
    hex(randomblob(2)) || '-' ||
    '4' || substr(hex(randomblob(2)), 2) || '-' ||
    substr('89ab', 1 + (abs(random()) % 4), 1) || substr(hex(randomblob(2)), 2) || '-' ||
    hex(randomblob(6))
  )),
	`organization_id` text,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`description` text,
	`scope` text DEFAULT 'organization' NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`supersedes_revision_id` text,
	`rollback_of_revision_id` text,
	`change_summary` text,
	`published_at` text,
	`published_by` text,
	`templates` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP),
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP),
	CONSTRAINT `fk_workspace_template_sets_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_workspace_template_sets_supersedes_revision_id_workspace_template_sets_id_fk` FOREIGN KEY (`supersedes_revision_id`) REFERENCES `workspace_template_sets`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `fk_workspace_template_sets_rollback_of_revision_id_workspace_template_sets_id_fk` FOREIGN KEY (`rollback_of_revision_id`) REFERENCES `workspace_template_sets`(`id`) ON DELETE RESTRICT,
	CONSTRAINT `uniq_workspace_template_sets_scope_slug_version` UNIQUE(`scope`,`slug`,`version`)
);
--> statement-breakpoint
INSERT INTO `__new_workspace_template_sets`(`id`, `organization_id`, `name`, `slug`, `description`, `scope`, `status`, `version`, `templates`, `created_at`, `updated_at`) SELECT `id`, `organization_id`, `name`, `slug`, `description`, `scope`, `status`, `version`, `templates`, `created_at`, `updated_at` FROM `workspace_template_sets`;--> statement-breakpoint
DROP TABLE `workspace_template_sets`;--> statement-breakpoint
ALTER TABLE `__new_workspace_template_sets` RENAME TO `workspace_template_sets`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `idx_policy_packs_org` ON `policy_packs` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_policy_packs_status` ON `policy_packs` (`status`);--> statement-breakpoint
CREATE INDEX `idx_policy_packs_target` ON `policy_packs` (`target`);--> statement-breakpoint
CREATE INDEX `idx_policy_packs_family` ON `policy_packs` (`scope`,`slug`,`version`);--> statement-breakpoint
CREATE INDEX `idx_runtime_profiles_org` ON `runtime_profiles` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_runtime_profiles_status` ON `runtime_profiles` (`status`);--> statement-breakpoint
CREATE INDEX `idx_runtime_profiles_family` ON `runtime_profiles` (`scope`,`slug`,`version`);--> statement-breakpoint
CREATE INDEX `idx_workspace_template_sets_org` ON `workspace_template_sets` (`organization_id`);--> statement-breakpoint
CREATE INDEX `idx_workspace_template_sets_status` ON `workspace_template_sets` (`status`);--> statement-breakpoint
CREATE INDEX `idx_workspace_template_sets_family` ON `workspace_template_sets` (`scope`,`slug`,`version`);--> statement-breakpoint
CREATE INDEX `idx_tedi_control_plane_binding_history_tedi_kind_time` ON `tedi_control_plane_binding_history` (`tedi_id`,`kind`,`effective_at`);--> statement-breakpoint
CREATE INDEX `idx_tedi_control_plane_binding_history_org` ON `tedi_control_plane_binding_history` (`organization_id`);
