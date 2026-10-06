CREATE TABLE `cms_restore_fences` (
	`site_id` text PRIMARY KEY,
	`slug` text NOT NULL,
	`generation` text NOT NULL,
	`capture_id` text NOT NULL,
	`closed_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cms_restore_permits` (
	`id` text PRIMARY KEY,
	`site_id` text NOT NULL,
	`slug` text NOT NULL,
	`entered_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE INDEX `cms_restore_permits_site_slug_idx` ON `cms_restore_permits` (`site_id`,`slug`);
