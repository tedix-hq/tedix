CREATE TABLE `os_workspace_summaries` (
	`workspace_id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`revision` integer NOT NULL,
	`usage` text DEFAULT '{}' NOT NULL,
	`run_status` text DEFAULT '{}' NOT NULL,
	`work_links` text DEFAULT '[]' NOT NULL,
	`published_at` text NOT NULL,
	`applied_at` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_os_workspace_summaries_workspace_id_os_workspaces_id_fk` FOREIGN KEY (`workspace_id`) REFERENCES `os_workspaces`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_os_workspace_summaries_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `os_workspace_summaries_org_idx` ON `os_workspace_summaries` (`organization_id`);