CREATE TABLE `tenant_tool_policy_preparations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`descriptor` text NOT NULL,
	`descriptor_digest` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	CONSTRAINT `fk_tenant_tool_policy_preparations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `tenant_tool_policies` ADD `mount_descriptor` text;--> statement-breakpoint
ALTER TABLE `tenant_tool_policies` ADD `mount_digest` text;--> statement-breakpoint
CREATE INDEX `tenant_tool_policy_preparations_owner_idx` ON `tenant_tool_policy_preparations` (`organization_id`,`owner_id`);