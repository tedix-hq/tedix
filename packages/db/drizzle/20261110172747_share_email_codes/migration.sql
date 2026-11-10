CREATE TABLE `os_share_email_codes` (
	`id` text PRIMARY KEY,
	`share_link_id` text NOT NULL,
	`email` text NOT NULL,
	`code_hash` text NOT NULL,
	`ip_hash` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`consumed_at` text,
	CONSTRAINT `fk_os_share_email_codes_share_link_id_os_share_links_id_fk` FOREIGN KEY (`share_link_id`) REFERENCES `os_share_links`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
ALTER TABLE `os_share_sessions` ADD `verified_email` text;--> statement-breakpoint
CREATE INDEX `os_share_email_codes_link_email_created_idx` ON `os_share_email_codes` (`share_link_id`,`email`,`created_at`);--> statement-breakpoint
CREATE INDEX `os_share_email_codes_ip_created_idx` ON `os_share_email_codes` (`ip_hash`,`created_at`);