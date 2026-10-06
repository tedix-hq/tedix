CREATE TABLE `os_workspace_projects` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`project_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_by_kind` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`removed_at` text,
	CONSTRAINT `fk_os_workspace_projects_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `os_workspace_projects_workspace_fk` FOREIGN KEY (`organization_id`,`workspace_id`) REFERENCES `os_workspaces`(`organization_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT `os_workspace_projects_project_fk` FOREIGN KEY (`organization_id`,`project_id`) REFERENCES `projects`(`org_id`,`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `os_workspace_projects_workspace_project_unique` ON `os_workspace_projects` (`workspace_id`,`project_id`);--> statement-breakpoint
CREATE INDEX `os_workspace_projects_org_workspace_status_idx` ON `os_workspace_projects` (`organization_id`,`workspace_id`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_workspaces_org_id_unique` ON `os_workspaces` (`organization_id`,`id`);