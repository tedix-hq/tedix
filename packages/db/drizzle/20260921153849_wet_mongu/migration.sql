CREATE TABLE `work_sprint_items` (
	`org_id` text NOT NULL,
	`sprint_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `work_sprint_items_pk` PRIMARY KEY(`org_id`, `sprint_id`, `work_item_id`),
	CONSTRAINT `fk_work_sprint_item_sprint` FOREIGN KEY (`org_id`,`sprint_id`) REFERENCES `work_sprints`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_sprint_item_work` FOREIGN KEY (`org_id`,`work_item_id`) REFERENCES `work_items`(`org_id`,`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `work_sprints` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`goal` text,
	`status` text DEFAULT 'planned' NOT NULL,
	`start_at` text NOT NULL,
	`end_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT `fk_work_sprints_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_work_sprint_project` FOREIGN KEY (`org_id`,`project_id`) REFERENCES `projects`(`org_id`,`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_work_sprint_dates" CHECK("end_at" >= "start_at")
);
--> statement-breakpoint
ALTER TABLE `work_items` ADD `start_at` text;--> statement-breakpoint
ALTER TABLE `work_items` ADD `duration_days` integer;--> statement-breakpoint
CREATE INDEX `idx_work_sprint_items_work` ON `work_sprint_items` (`org_id`,`work_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_sprints_org_id` ON `work_sprints` (`org_id`,`id`);--> statement-breakpoint
CREATE INDEX `idx_work_sprints_project_start` ON `work_sprints` (`org_id`,`project_id`,`start_at`);