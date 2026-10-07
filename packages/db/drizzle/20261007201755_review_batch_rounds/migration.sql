DROP INDEX IF EXISTS `os_review_batches_share_unique`;--> statement-breakpoint
CREATE INDEX `os_review_batches_share_created_idx` ON `os_review_batches` (`share_link_id`,`created_at`);