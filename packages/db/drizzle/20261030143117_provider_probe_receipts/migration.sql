CREATE TABLE `provider_probe_receipts` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`actor_user_id` text NOT NULL,
	`profile_id` text NOT NULL,
	`profile_digest` text NOT NULL,
	`args_digest` text NOT NULL,
	`expires_at` text NOT NULL,
	CONSTRAINT `fk_provider_probe_receipts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `tenant_tool_policies` ADD `policy_set` text;--> statement-breakpoint
CREATE INDEX `provider_probe_receipts_org_idx` ON `provider_probe_receipts` (`organization_id`,`expires_at`);