CREATE TABLE `__new_cms_sites` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`canonical_url` text NOT NULL,
	`custom_domain` text UNIQUE,
	`public_path_prefix` text,
	`database_id` text UNIQUE,
	`template_slug` text DEFAULT 'tedix' NOT NULL,
	`config` text,
	`mcp_app_id` text,
	`authoring_app_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_cms_sites_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_cms_sites_mcp_app_id_apps_id_fk` FOREIGN KEY (`mcp_app_id`) REFERENCES `apps`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_cms_sites_authoring_app_id_apps_id_fk` FOREIGN KEY (`authoring_app_id`) REFERENCES `apps`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
INSERT INTO `__new_cms_sites`(`id`, `organization_id`, `slug`, `name`, `description`, `status`, `canonical_url`, `custom_domain`, `public_path_prefix`, `database_id`, `template_slug`, `config`, `mcp_app_id`, `authoring_app_id`, `created_at`, `updated_at`) SELECT `id`, `organization_id`, `slug`, `name`, `description`, `status`, `canonical_url`, `custom_domain`, `public_path_prefix`, `database_id`, `template_slug`, `config`, `mcp_app_id`, `authoring_app_id`, `created_at`, `updated_at` FROM `cms_sites`;--> statement-breakpoint
DROP TABLE `cms_sites`;--> statement-breakpoint
ALTER TABLE `__new_cms_sites` RENAME TO `cms_sites`;--> statement-breakpoint
CREATE TABLE `__new_cms_deprovision_operations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`slug` text NOT NULL,
	`database_id` text,
	`authoring_app_id` text,
	`status` text DEFAULT 'queued' NOT NULL,
	`stage` text DEFAULT 'queued' NOT NULL,
	`deleted` text DEFAULT '[]' NOT NULL,
	`errors` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_cms_deprovision_operations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_cms_deprovision_operations`(`id`, `organization_id`, `slug`, `database_id`, `authoring_app_id`, `status`, `stage`, `deleted`, `errors`, `created_at`, `updated_at`) SELECT `id`, `organization_id`, `slug`, `database_id`, `authoring_app_id`, `status`, `stage`, `deleted`, `errors`, `created_at`, `updated_at` FROM `cms_deprovision_operations`;--> statement-breakpoint
DROP TABLE `cms_deprovision_operations`;--> statement-breakpoint
ALTER TABLE `__new_cms_deprovision_operations` RENAME TO `cms_deprovision_operations`;--> statement-breakpoint
CREATE UNIQUE INDEX `cms_sites_slug_unique` ON `cms_sites` (`slug`);--> statement-breakpoint
CREATE INDEX `cms_sites_org_idx` ON `cms_sites` (`organization_id`);--> statement-breakpoint
CREATE INDEX `cms_sites_status_idx` ON `cms_sites` (`status`);--> statement-breakpoint
CREATE INDEX `cms_sites_mcp_app_idx` ON `cms_sites` (`mcp_app_id`);--> statement-breakpoint
CREATE INDEX `cms_sites_authoring_app_idx` ON `cms_sites` (`authoring_app_id`);--> statement-breakpoint
CREATE INDEX `cms_deprovision_operations_org_idx` ON `cms_deprovision_operations` (`organization_id`);
