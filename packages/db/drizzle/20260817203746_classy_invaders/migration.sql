CREATE TABLE `os_share_sessions` (
	`id` text PRIMARY KEY,
	`share_link_id` text NOT NULL,
	`session_token_hash` text NOT NULL,
	`created_at` text DEFAULT (datetime('now')) NOT NULL,
	`last_seen_at` text DEFAULT (datetime('now')) NOT NULL,
	`expires_at` text NOT NULL,
	`revoked_at` text,
	CONSTRAINT `fk_os_share_sessions_share_link_id_os_share_links_id_fk` FOREIGN KEY (`share_link_id`) REFERENCES `os_share_links`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `os_share_links` ADD `revision_mode` text DEFAULT 'living' NOT NULL;--> statement-breakpoint
ALTER TABLE `os_share_links` ADD `pinned_revision_id` text;--> statement-breakpoint
ALTER TABLE `os_share_links` ADD `pinned_snapshot` text;--> statement-breakpoint
ALTER TABLE `os_share_links` ADD `note` text;--> statement-breakpoint
ALTER TABLE `os_share_links` ADD `policy_max_role` text;--> statement-breakpoint
ALTER TABLE `os_share_links` ADD `policy_reason` text;--> statement-breakpoint
ALTER TABLE `os_share_links` ADD `policy_restricted_at` text;--> statement-breakpoint
CREATE INDEX `os_share_sessions_link_idx` ON `os_share_sessions` (`share_link_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `os_share_sessions_token_hash_unique` ON `os_share_sessions` (`session_token_hash`);