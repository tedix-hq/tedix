ALTER TABLE `app_tools` ADD `review_state` text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE `app_tools` ADD `review_diff` text;--> statement-breakpoint
ALTER TABLE `app_tools` ADD `review_batch_id` text;--> statement-breakpoint
CREATE INDEX `idx_app_tools_app_review` ON `app_tools` (`app_id`,`review_state`);