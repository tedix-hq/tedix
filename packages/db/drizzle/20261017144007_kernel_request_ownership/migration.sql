CREATE TABLE `kernel_request_events` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`request_id` text NOT NULL,
	`version` integer NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` text NOT NULL,
	CONSTRAINT `fk_kernel_request_events_request_id_kernel_requests_id_fk` FOREIGN KEY (`request_id`) REFERENCES `kernel_requests`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `kernel_requests` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`owner_user_id` text NOT NULL,
	`source_kind` text NOT NULL,
	`source_id` text NOT NULL,
	`conversation_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`snapshot` text NOT NULL,
	`next_owner` text NOT NULL,
	`next_action` text NOT NULL,
	`next_due_at` text,
	`last_event_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT `fk_kernel_requests_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_request_events_version_unique` ON `kernel_request_events` (`request_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `kernel_requests_source_unique` ON `kernel_requests` (`organization_id`,`owner_user_id`,`source_kind`,`source_id`);--> statement-breakpoint
CREATE INDEX `kernel_requests_due_idx` ON `kernel_requests` (`organization_id`,`next_due_at`);