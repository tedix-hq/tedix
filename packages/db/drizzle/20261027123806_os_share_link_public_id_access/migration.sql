CREATE TABLE `os_share_link_invitees` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`share_link_id` text NOT NULL,
	`email` text,
	`user_id` text,
	`name` text,
	`added_by_kind` text NOT NULL,
	`added_by_id` text NOT NULL,
	`added_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_os_share_link_invitees_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_os_share_link_invitees_share_link_id_os_share_links_id_fk` FOREIGN KEY (`share_link_id`) REFERENCES `os_share_links`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `os_share_links` ADD `public_id` text;--> statement-breakpoint
ALTER TABLE `os_share_links` ADD `access` text DEFAULT 'anyone_with_link' NOT NULL;--> statement-breakpoint
UPDATE `os_share_links` SET `public_id` = lower(hex(randomblob(11))) WHERE `public_id` IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `os_share_link_invitees_link_email_unique` ON `os_share_link_invitees` (`share_link_id`,`email`);--> statement-breakpoint
CREATE INDEX `os_share_link_invitees_link_user_idx` ON `os_share_link_invitees` (`share_link_id`,`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_share_links_public_id_unique` ON `os_share_links` (`public_id`);