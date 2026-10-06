CREATE TABLE `os_workspace_resources` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`connection_scope` text NOT NULL,
	`required_scopes` text DEFAULT '[]' NOT NULL,
	`resource_type` text NOT NULL,
	`provider_resource_id` text NOT NULL,
	`name` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`removed_at` text,
	CONSTRAINT `fk_os_workspace_resources_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_os_workspace_resources_workspace_id_os_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `os_workspaces`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `os_workspace_resources_provider_object_unique` ON `os_workspace_resources` (`workspace_id`,`provider_id`,`connection_scope`,`resource_type`,`provider_resource_id`);--> statement-breakpoint
CREATE INDEX `os_workspace_resources_org_workspace_idx` ON `os_workspace_resources` (`organization_id`,`workspace_id`,`status`);