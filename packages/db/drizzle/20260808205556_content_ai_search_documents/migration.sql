CREATE TABLE `content_source_documents` (
	`id` text PRIMARY KEY,
	`app_id` text NOT NULL,
	`source_id` text,
	`canonical_url` text NOT NULL,
	`source_revision` text NOT NULL,
	`visibility` text NOT NULL,
	`object_key` text NOT NULL,
	`digest` text NOT NULL,
	`title` text NOT NULL,
	`content_type` text NOT NULL,
	`ai_search_item_id` text,
	`ai_search_status` text DEFAULT 'pending' NOT NULL,
	`ai_search_error` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_content_source_documents_app_id_apps_id_fk` FOREIGN KEY (`app_id`) REFERENCES `apps`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_content_source_documents_source_id_content_sources_id_fk` FOREIGN KEY (`source_id`) REFERENCES `content_sources`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_content_source_documents_app_url` ON `content_source_documents` (`app_id`,`canonical_url`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_content_source_documents_app_object` ON `content_source_documents` (`app_id`,`object_key`);--> statement-breakpoint
CREATE INDEX `idx_content_source_documents_source_id` ON `content_source_documents` (`source_id`);--> statement-breakpoint
CREATE INDEX `idx_content_source_documents_projection` ON `content_source_documents` (`ai_search_status`);