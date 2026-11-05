CREATE TABLE `tedi_email_trusted_recipients` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`address` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`revoked_at` text,
	`revoked_by` text,
	CONSTRAINT `fk_tedi_email_trusted_recipients_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_email_trusted_recipients_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_tedi_email_trusted_recipient_active` ON `tedi_email_trusted_recipients` (`tedi_id`,`address`) WHERE "tedi_email_trusted_recipients"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX `idx_tedi_email_trusted_recipients_org_tedi` ON `tedi_email_trusted_recipients` (`organization_id`,`tedi_id`);