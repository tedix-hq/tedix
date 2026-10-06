CREATE TABLE `artifact_redaction_candidates` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`parent_artifact_id` text NOT NULL,
	`parent_content_digest` text NOT NULL,
	`child_artifact_id` text NOT NULL,
	`child_content_digest` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`created_by_member_id` text NOT NULL,
	`created_by_user_id` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_artifact_redaction_candidates_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_artifact_redaction_candidates_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`),
	CONSTRAINT `fk_artifact_redaction_candidates_parent_artifact_id_tedi_artifacts_id_fk` FOREIGN KEY (`parent_artifact_id`) REFERENCES `tedi_artifacts`(`id`),
	CONSTRAINT `fk_artifact_redaction_candidates_child_artifact_id_tedi_artifacts_id_fk` FOREIGN KEY (`child_artifact_id`) REFERENCES `tedi_artifacts`(`id`)
);
--> statement-breakpoint
CREATE TABLE `artifact_release_reviews` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text NOT NULL,
	`candidate_id` text NOT NULL,
	`event_type` text NOT NULL,
	`previous_review_id` text NOT NULL,
	`target_approval_id` text,
	`child_content_digest` text NOT NULL,
	`reviewer_member_id` text NOT NULL,
	`reviewer_user_id` text NOT NULL,
	`reviewer_descope_user_id` text NOT NULL,
	`attestation` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_artifact_release_reviews_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_artifact_release_reviews_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`),
	CONSTRAINT `fk_artifact_release_reviews_candidate_id_artifact_redaction_candidates_id_fk` FOREIGN KEY (`candidate_id`) REFERENCES `artifact_redaction_candidates`(`id`)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_artifact_redaction_candidates_child` ON `artifact_redaction_candidates` (`child_artifact_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_artifact_redaction_candidates_idempotency` ON `artifact_redaction_candidates` (`organization_id`,`parent_artifact_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_artifact_redaction_candidates_parent` ON `artifact_redaction_candidates` (`organization_id`,`parent_artifact_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_artifact_release_reviews_previous` ON `artifact_release_reviews` (`candidate_id`,`previous_review_id`);--> statement-breakpoint
CREATE INDEX `idx_artifact_release_reviews_candidate` ON `artifact_release_reviews` (`organization_id`,`candidate_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_artifact_release_reviews_target` ON `artifact_release_reviews` (`target_approval_id`);