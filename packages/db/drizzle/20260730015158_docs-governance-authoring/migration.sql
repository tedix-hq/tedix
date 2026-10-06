CREATE TABLE `docs_changes` (
	`id` text PRIMARY KEY,
	`site_id` text NOT NULL,
	`status` text DEFAULT 'proposed' NOT NULL,
	`path` text NOT NULL,
	`message` text NOT NULL,
	`base_revision` text NOT NULL,
	`proposal_branch` text NOT NULL,
	`proposal_revision` text NOT NULL,
	`content_sha256` text NOT NULL,
	`preview_build_id` text,
	`committed_revision` text,
	`proposed_by_type` text NOT NULL,
	`proposed_by_id` text NOT NULL,
	`proposed_by_session_id` text,
	`committed_by_type` text,
	`committed_by_id` text,
	`committed_by_session_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	`committed_at` text,
	CONSTRAINT `fk_docs_changes_site_id_docs_sites_id_fk` FOREIGN KEY (`site_id`) REFERENCES `docs_sites`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `docs_releases` (
	`id` text PRIMARY KEY,
	`site_id` text NOT NULL,
	`build_id` text NOT NULL,
	`previous_build_id` text,
	`action` text NOT NULL,
	`actor_type` text NOT NULL,
	`actor_id` text NOT NULL,
	`actor_session_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_docs_releases_site_id_docs_sites_id_fk` FOREIGN KEY (`site_id`) REFERENCES `docs_sites`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_docs_releases_build_id_docs_builds_id_fk` FOREIGN KEY (`build_id`) REFERENCES `docs_builds`(`id`) ON DELETE RESTRICT
);
--> statement-breakpoint
ALTER TABLE `docs_builds` ADD `source_branch` text;--> statement-breakpoint
ALTER TABLE `docs_builds` ADD `proposal_id` text;--> statement-breakpoint
ALTER TABLE `docs_builds` ADD `requested_by_type` text;--> statement-breakpoint
ALTER TABLE `docs_builds` ADD `requested_by_id` text;--> statement-breakpoint
ALTER TABLE `docs_builds` ADD `requested_by_session_id` text;--> statement-breakpoint
CREATE INDEX `docs_changes_site_created_idx` ON `docs_changes` (`site_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `docs_changes_status_idx` ON `docs_changes` (`status`);--> statement-breakpoint
CREATE INDEX `docs_releases_site_created_idx` ON `docs_releases` (`site_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `docs_releases_build_idx` ON `docs_releases` (`build_id`);