CREATE TABLE `principal_identities` (
	`id` text PRIMARY KEY,
	`organization_id` text,
	`principal_type` text NOT NULL,
	`principal_id` text NOT NULL,
	`provider` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`last_verified_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_principal_identities_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_principal_identity_provider" CHECK(length("provider") > 0),
	CONSTRAINT "chk_principal_identity_issuer" CHECK(length("issuer") > 0),
	CONSTRAINT "chk_principal_identity_subject" CHECK(length("subject") > 0),
	CONSTRAINT "chk_principal_identity_org_principal" CHECK("principal_type" != 'organization' OR "organization_id" = "principal_id")
);
--> statement-breakpoint
ALTER TABLE `organization_members` ADD `user_id` text;--> statement-breakpoint
UPDATE `organization_members`
SET `user_id` = `descope_user_id`
WHERE `user_id` IS NULL
  AND EXISTS (
    SELECT 1 FROM `users` WHERE `users`.`id` = `organization_members`.`descope_user_id`
  );--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_org_member_user` ON `organization_members` (`organization_id`,`user_id`) WHERE "organization_members"."user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_org_members_canonical_user` ON `organization_members` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_principal_identity_external` ON `principal_identities` (`provider`,`issuer`,`subject`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_principal_identity_canonical` ON `principal_identities` (`principal_type`,`principal_id`,`provider`,`issuer`,`subject`);--> statement-breakpoint
CREATE INDEX `idx_principal_identity_principal` ON `principal_identities` (`principal_type`,`principal_id`,`status`);--> statement-breakpoint
CREATE INDEX `idx_principal_identity_org` ON `principal_identities` (`organization_id`,`principal_type`,`status`);
