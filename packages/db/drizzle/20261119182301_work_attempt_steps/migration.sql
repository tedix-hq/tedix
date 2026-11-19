CREATE TABLE `work_attempt_messages` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`kind` text NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`sender_type` text NOT NULL,
	`sender_id` text NOT NULL,
	`created_at` text NOT NULL,
	`delivered_at` text,
	`applied_at` text,
	CONSTRAINT `fk_work_attempt_messages_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `work_attempt_steps` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`work_item_id` text NOT NULL,
	`attempt_id` text NOT NULL,
	`seq` integer NOT NULL,
	`at` integer NOT NULL,
	`kind` text NOT NULL,
	`text` text NOT NULL,
	CONSTRAINT `fk_work_attempt_steps_org_id_organizations_id_fk` FOREIGN KEY (`org_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_work_attempt_messages_attempt_delivered` ON `work_attempt_messages` (`attempt_id`,`delivered_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_work_attempt_step_seq` ON `work_attempt_steps` (`attempt_id`,`seq`);--> statement-breakpoint
CREATE INDEX `idx_work_attempt_steps_item_attempt_seq` ON `work_attempt_steps` (`work_item_id`,`attempt_id`,`seq`);