CREATE TABLE `tenant_provider_identity_preparations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`owner_id` text NOT NULL,
	`mount` text NOT NULL,
	`probe_mount` text NOT NULL,
	`profile` text NOT NULL,
	`profile_digest` text NOT NULL,
	`resource_generation_digest` text NOT NULL,
	`expires_at` text NOT NULL,
	`consumed_at` text,
	CONSTRAINT `fk_tenant_provider_identity_preparations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `tenant_provider_identity_profiles` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`mount` text NOT NULL,
	`probe_mount` text NOT NULL,
	`profile` text NOT NULL,
	`safety_attestation` text NOT NULL,
	`profile_digest` text NOT NULL,
	`resource_generation_digest` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`revoked_at` text,
	CONSTRAINT `fk_tenant_provider_identity_profiles_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `tenant_provider_identity_preparations_owner_idx` ON `tenant_provider_identity_preparations` (`organization_id`,`owner_id`);--> statement-breakpoint
CREATE INDEX `tenant_provider_identity_profiles_org_idx` ON `tenant_provider_identity_profiles` (`organization_id`);