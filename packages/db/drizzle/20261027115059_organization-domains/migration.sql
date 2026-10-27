-- tedix: destructive-reviewed Work-Item: 755e5a3a-331b-4a8f-9d61-007339a69785
-- Preserve every CMS claim column, ID, foreign key and index while making site_id nullable.
-- No table references cms_domain_claims; recreate it with deferred foreign keys.
-- organization-domains.test.ts verifies existing claim preservation with foreign keys enabled.
PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_cms_domain_claims` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`site_id` text,
	`hostname` text NOT NULL,
	`kind` text DEFAULT 'primary' NOT NULL,
	`verification_token` text NOT NULL,
	`provider_hostname_id` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_cms_domain_claims_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_cms_domain_claims_site_id_cms_sites_id_fk` FOREIGN KEY (`site_id`) REFERENCES `cms_sites`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
INSERT INTO `__new_cms_domain_claims`(`id`, `organization_id`, `site_id`, `hostname`, `kind`, `verification_token`, `provider_hostname_id`, `status`, `expires_at`, `created_at`, `updated_at`) SELECT `id`, `organization_id`, `site_id`, `hostname`, `kind`, `verification_token`, `provider_hostname_id`, `status`, `expires_at`, `created_at`, `updated_at` FROM `cms_domain_claims`;--> statement-breakpoint
DROP TABLE `cms_domain_claims`;--> statement-breakpoint
ALTER TABLE `__new_cms_domain_claims` RENAME TO `cms_domain_claims`;--> statement-breakpoint
PRAGMA defer_foreign_keys=OFF;--> statement-breakpoint
CREATE UNIQUE INDEX `cms_domain_claims_hostname_unique` ON `cms_domain_claims` (`hostname`);--> statement-breakpoint
CREATE UNIQUE INDEX `cms_domain_claims_provider_unique` ON `cms_domain_claims` (`provider_hostname_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cms_domain_claims_site_pending_unique` ON `cms_domain_claims` (`site_id`) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX `cms_domain_claims_site_idx` ON `cms_domain_claims` (`organization_id`,`site_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cms_domain_claims_organization_unique` ON `cms_domain_claims` (`organization_id`) WHERE kind = 'organization';