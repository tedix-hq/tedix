CREATE TABLE `os_review_batches` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`share_link_id` text NOT NULL,
	`source_output_id` text NOT NULL,
	`source_revision_id` text NOT NULL,
	`title` text NOT NULL,
	`cards` text NOT NULL,
	`access_envelope` text NOT NULL,
	`created_by_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_os_review_batches_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_os_review_batches_share_link_id_os_share_links_id_fk` FOREIGN KEY (`share_link_id`) REFERENCES `os_share_links`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `os_review_feedback` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`batch_id` text NOT NULL,
	`card_id` text NOT NULL,
	`reviewer_id` text NOT NULL,
	`revision` integer NOT NULL,
	`decision` text NOT NULL,
	`edited_reply` text NOT NULL,
	`reason` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_os_review_feedback_batch_id_os_review_batches_id_fk` FOREIGN KEY (`batch_id`) REFERENCES `os_review_batches`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `os_review_batches_share_unique` ON `os_review_batches` (`share_link_id`);--> statement-breakpoint
CREATE INDEX `os_review_batches_org_idx` ON `os_review_batches` (`organization_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_review_feedback_recipient_unique` ON `os_review_feedback` (`batch_id`,`card_id`,`reviewer_id`);