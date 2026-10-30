CREATE TABLE `tenant_tool_policy_mount_revisions` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`organization_id` text NOT NULL,
	`root_app_id` text NOT NULL,
	`mounted_tool_id` text NOT NULL,
	`policy_id` text NOT NULL,
	CONSTRAINT `fk_tenant_tool_policy_mount_revisions_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `tenant_tool_policies` ADD `root_app_id` text;--> statement-breakpoint
ALTER TABLE `tenant_tool_policies` ADD `mounted_tool_id` text;--> statement-breakpoint
ALTER TABLE `tenant_tool_policy_preparations` ADD `source_tool_digest` text;--> statement-breakpoint
CREATE INDEX `tenant_tool_policy_mount_revision_lookup_idx` ON `tenant_tool_policy_mount_revisions` (`organization_id`,`root_app_id`,`mounted_tool_id`,`sequence`);