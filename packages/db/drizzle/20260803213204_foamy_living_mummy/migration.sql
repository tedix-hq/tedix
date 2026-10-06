CREATE TABLE `work_item_sources` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`project_id` text,
	`work_item_id` text,
	`provider` text NOT NULL,
	`external_id` text NOT NULL,
	`kind` text DEFAULT 'other' NOT NULL,
	`external_url` text,
	`title` text,
	`content_hash` text,
	`state` text DEFAULT 'current' NOT NULL,
	`last_checked_at` text,
	`last_changed_at` text,
	`missing_since_at` text,
	`tombstoned_at` text,
	`attributed_to` text,
	`metadata` text DEFAULT '{}',
	`created_at` text NOT NULL,
	`updated_at` text,
	CONSTRAINT `fk_work_item_sources_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_item_sources_project_id_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_item_source_owner_external` ON `work_item_sources` (`org_id`,`provider`,`external_id`,coalesce("project_id", ''),coalesce("work_item_id", ''));--> statement-breakpoint
CREATE INDEX `idx_work_item_source_project` ON `work_item_sources` (`org_id`,`project_id`,`state`);--> statement-breakpoint
CREATE INDEX `idx_work_item_source_work_item` ON `work_item_sources` (`org_id`,`work_item_id`);--> statement-breakpoint
CREATE INDEX `idx_work_item_source_sweep` ON `work_item_sources` (`org_id`,`provider`,`last_checked_at`);