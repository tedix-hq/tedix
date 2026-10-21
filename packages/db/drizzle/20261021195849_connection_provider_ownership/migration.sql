CREATE TABLE `connection_provider_ownership` (
	`app_id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_connection_provider_ownership_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `connection_provider_ownership_org_idx` ON `connection_provider_ownership` (`organization_id`);