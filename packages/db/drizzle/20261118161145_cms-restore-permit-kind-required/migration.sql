-- tedix: destructive-reviewed Work-Item: 4a2fbe13-9f9b-4c41-a477-70205e81f63c
-- Drops the 'legacy' default on restore permit kind. Every writer sets kind
-- and production held no 'legacy' permit on 18 Nov 2026 (nested 98, outer 5,
-- scheduled 35). The rebuild copies every row with its kind unchanged; the
-- table has no foreign keys.
CREATE TABLE `__new_cms_restore_permits` (
	`id` text PRIMARY KEY,
	`site_id` text NOT NULL,
	`slug` text NOT NULL,
	`restore_epoch` integer DEFAULT 0 NOT NULL,
	`kind` text NOT NULL,
	`entered_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_cms_restore_permits`(`id`, `site_id`, `slug`, `restore_epoch`, `kind`, `entered_at`) SELECT `id`, `site_id`, `slug`, `restore_epoch`, `kind`, `entered_at` FROM `cms_restore_permits`;--> statement-breakpoint
DROP TABLE `cms_restore_permits`;--> statement-breakpoint
ALTER TABLE `__new_cms_restore_permits` RENAME TO `cms_restore_permits`;--> statement-breakpoint
CREATE INDEX `cms_restore_permits_site_slug_idx` ON `cms_restore_permits` (`site_id`,`slug`);