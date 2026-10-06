CREATE TABLE `cms_capture_cron_pauses` (
	`site_id` text PRIMARY KEY,
	`slug` text NOT NULL,
	`capture_id` text NOT NULL,
	`expires_at_unix` integer NOT NULL,
	`drained_at_unix` integer
);
