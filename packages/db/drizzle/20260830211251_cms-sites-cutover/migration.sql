CREATE TABLE `cms_sites` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`status` text DEFAULT 'active' NOT NULL,
	`canonical_url` text NOT NULL,
	`custom_domain` text UNIQUE,
	`public_path_prefix` text,
	`database_id` text NOT NULL UNIQUE,
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
CREATE UNIQUE INDEX `cms_sites_slug_unique` ON `cms_sites` (`slug`);--> statement-breakpoint
CREATE INDEX `cms_sites_org_idx` ON `cms_sites` (`organization_id`);--> statement-breakpoint
CREATE INDEX `cms_sites_status_idx` ON `cms_sites` (`status`);--> statement-breakpoint
CREATE INDEX `cms_sites_mcp_app_idx` ON `cms_sites` (`mcp_app_id`);--> statement-breakpoint
CREATE INDEX `cms_sites_authoring_app_idx` ON `cms_sites` (`authoring_app_id`);
