CREATE TABLE `os_share_skill_read_grants` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`share_link_id` text NOT NULL,
	`workspace_id` text NOT NULL,
	`gadget_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`provider_resource_id` text NOT NULL,
	`slot` text NOT NULL,
	`approved_by_user_id` text NOT NULL,
	`approved_at` text NOT NULL,
	`revoked_at` text,
	CONSTRAINT `fk_os_share_skill_read_grants_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_os_share_skill_read_grants_share_link_id_os_share_links_id_fk` FOREIGN KEY (`share_link_id`) REFERENCES `os_share_links`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `os_share_skill_read_grants_slot_unique` ON `os_share_skill_read_grants` (`organization_id`,`share_link_id`,`revision_id`,`slot`);