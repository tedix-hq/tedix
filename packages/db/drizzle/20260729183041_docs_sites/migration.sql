CREATE TABLE `docs_builds` (
	`id` text PRIMARY KEY,
	`site_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`phase` text DEFAULT 'queued' NOT NULL,
	`source_revision` text,
	`manifest_key` text,
	`error` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`started_at` text,
	`finished_at` text,
	CONSTRAINT `fk_docs_builds_site_id_docs_sites_id_fk` FOREIGN KEY (`site_id`) REFERENCES `docs_sites`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `docs_sites` (
	`id` text PRIMARY KEY,
	`org_slug` text NOT NULL,
	`slug` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`canonical_url` text NOT NULL,
	`source_provider` text NOT NULL,
	`repository_url` text,
	`artifacts_repository` text,
	`branch` text DEFAULT 'main' NOT NULL,
	`content_root` text DEFAULT 'docs' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`active_build_id` text,
	`latest_build_id` text,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`updated_at` text DEFAULT (datetime('now')) NOT NULL,
	CONSTRAINT `fk_docs_sites_org_slug_organizations_slug_fk` FOREIGN KEY (`org_slug`) REFERENCES `organizations`(`slug`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `docs_builds_site_created_idx` ON `docs_builds` (`site_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `docs_builds_status_idx` ON `docs_builds` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `docs_sites_slug_unique` ON `docs_sites` (`slug`);--> statement-breakpoint
CREATE INDEX `docs_sites_org_slug_idx` ON `docs_sites` (`org_slug`);