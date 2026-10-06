CREATE TABLE `os_approval_rules` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`action_kind` text NOT NULL,
	`decision` text DEFAULT 'approve' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`disabled_at` text,
	CONSTRAINT `fk_os_approval_rules_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `os_share_links` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`resource_type` text NOT NULL,
	`resource_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`role` text DEFAULT 'viewer' NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`expires_at` text,
	`revoked_at` text,
	CONSTRAINT `fk_os_share_links_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `os_blueprints` ADD `visibility` text DEFAULT 'org' NOT NULL;--> statement-breakpoint
CREATE INDEX `os_approval_rules_org_kind_idx` ON `os_approval_rules` (`organization_id`,`action_kind`);--> statement-breakpoint
CREATE INDEX `os_share_links_org_resource_idx` ON `os_share_links` (`organization_id`,`resource_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_share_links_token_hash_unique` ON `os_share_links` (`token_hash`);