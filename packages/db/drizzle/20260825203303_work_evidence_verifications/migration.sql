CREATE TABLE `work_evidence_verifications` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`evidence_id` text NOT NULL,
	`source` text NOT NULL,
	`verifier_type` text DEFAULT 'system' NOT NULL,
	`verifier_id` text NOT NULL,
	`claimed` text DEFAULT '{}' NOT NULL,
	`observed` text DEFAULT '{}' NOT NULL,
	`matches_claim` integer NOT NULL,
	`observed_at` text NOT NULL,
	CONSTRAINT `fk_work_evidence_verifications_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_evidence_verifications_evidence_id_work_evidence_id_fk` FOREIGN KEY (`evidence_id`) REFERENCES `work_evidence`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_evidence_verification_item_org` FOREIGN KEY (`org_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_work_evidence_verification_system_authored" CHECK("verifier_type" = 'system')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_evidence_verification_source` ON `work_evidence_verifications` (`org_id`,`evidence_id`,`source`);--> statement-breakpoint
CREATE INDEX `idx_work_evidence_verifications_item` ON `work_evidence_verifications` (`org_id`,`work_item_id`);