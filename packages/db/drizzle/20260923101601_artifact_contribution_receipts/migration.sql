CREATE TABLE `tedi_artifact_contribution_receipts` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`producer_runtime_event_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`run_id` text NOT NULL,
	`content_digest` text NOT NULL,
	`observation_digest` text NOT NULL,
	`observations` text NOT NULL,
	`completeness` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_tedi_artifact_contribution_receipts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_artifact_contribution_receipts_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_tedi_artifact_contribution_receipts_artifact_id_tedi_artifacts_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `tedi_artifacts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_tedi_artifact_contribution_receipts_artifact` ON `tedi_artifact_contribution_receipts` (`artifact_id`);--> statement-breakpoint
CREATE INDEX `idx_tedi_artifact_contribution_receipts_tedi_created` ON `tedi_artifact_contribution_receipts` (`organization_id`,`tedi_id`,`created_at`);