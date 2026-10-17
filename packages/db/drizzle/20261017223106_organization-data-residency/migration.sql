CREATE TABLE `organization_residency_policies` (
	`organization_id` text PRIMARY KEY,
	`mode` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` text NOT NULL,
	`updated_by` text NOT NULL,
	CONSTRAINT `fk_organization_residency_policies_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "residency_policy_mode" CHECK("mode" IN ('unrestricted', 'eu')),
	CONSTRAINT "residency_policy_revision" CHECK("revision" > 0)
);
--> statement-breakpoint
CREATE TABLE `residency_execution_receipts` (
	`execution_id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`policy_revision` integer NOT NULL,
	`member_key` text NOT NULL,
	`pool_revision` integer NOT NULL,
	`provider_origin` text NOT NULL,
	`evidence_ref` text NOT NULL,
	`credential_ref` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `residency_provider_versions` (
	`id` text PRIMARY KEY,
	`member_key` text NOT NULL,
	`revision` integer NOT NULL,
	`config` text NOT NULL,
	`published_at` text NOT NULL,
	`published_by` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `residency_provider_version` ON `residency_provider_versions` (`member_key`,`revision`);