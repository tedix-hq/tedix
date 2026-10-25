CREATE TABLE `os_workspace_access_edges` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`target_user_id` text NOT NULL,
	`kind` text NOT NULL,
	`edge_key` text NOT NULL,
	`sharer_user_id` text,
	`link_id` text,
	`role` text,
	`note` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_os_workspace_access_edges_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `os_workspace_collaborators` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`user_id` text NOT NULL,
	`email` text,
	`name` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`first_opened_at` text,
	`last_opened_at` text,
	`cached_title` text,
	`cached_owner_name` text,
	`dismissed_at` text,
	CONSTRAINT `fk_os_workspace_collaborators_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `os_workspace_share_keys` (
	`key_hash` text PRIMARY KEY,
	`link_id` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_os_workspace_share_keys_link_id_os_workspace_share_links_id_fk` FOREIGN KEY (`link_id`) REFERENCES `os_workspace_share_links`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `os_workspace_share_links` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`creator_user_id` text NOT NULL,
	`role` text NOT NULL,
	`label` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`revoked_at` text,
	CONSTRAINT `fk_os_workspace_share_links_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `os_workspace_access_edges_unique` ON `os_workspace_access_edges` (`workspace_id`,`target_user_id`,`edge_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_workspace_collaborators_workspace_user_unique` ON `os_workspace_collaborators` (`workspace_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `os_workspace_collaborators_user_idx` ON `os_workspace_collaborators` (`user_id`);--> statement-breakpoint
CREATE INDEX `os_workspace_share_keys_link_idx` ON `os_workspace_share_keys` (`link_id`);--> statement-breakpoint
CREATE INDEX `os_workspace_share_links_workspace_idx` ON `os_workspace_share_links` (`workspace_id`);