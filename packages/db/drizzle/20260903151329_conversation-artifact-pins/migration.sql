CREATE TABLE `kernel_conversation_artifact_pins` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`artifact_id` text NOT NULL,
	`replay_name` text NOT NULL,
	`revision_digest` text NOT NULL,
	`artifact_uri` text NOT NULL,
	`artifact_name` text NOT NULL,
	`artifact_kind` text NOT NULL,
	`mime_type` text,
	`attached_by_type` text NOT NULL,
	`attached_by_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_kernel_conversation_artifact_pins_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_kernel_conversation_artifact_pins_artifact_id_tedi_artifacts_id_fk` FOREIGN KEY (`artifact_id`) REFERENCES `tedi_artifacts`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_kernel_conversation_artifact_pin_name` ON `kernel_conversation_artifact_pins` (`organization_id`,`conversation_id`,`replay_name`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_kernel_conversation_artifact_pin_revision` ON `kernel_conversation_artifact_pins` (`organization_id`,`conversation_id`,`artifact_id`,`revision_digest`);--> statement-breakpoint
CREATE INDEX `idx_kernel_conversation_artifact_pin_conversation` ON `kernel_conversation_artifact_pins` (`organization_id`,`conversation_id`,`created_at`);