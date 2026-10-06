CREATE TABLE `cms_domain_claims` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`site_id` text NOT NULL,
	`hostname` text NOT NULL,
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
CREATE UNIQUE INDEX `cms_domain_claims_hostname_unique` ON `cms_domain_claims` (`hostname`);--> statement-breakpoint
CREATE UNIQUE INDEX `cms_domain_claims_provider_unique` ON `cms_domain_claims` (`provider_hostname_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `cms_domain_claims_site_pending_unique` ON `cms_domain_claims` (`site_id`) WHERE status = 'pending';--> statement-breakpoint
CREATE INDEX `cms_domain_claims_site_idx` ON `cms_domain_claims` (`organization_id`,`site_id`);