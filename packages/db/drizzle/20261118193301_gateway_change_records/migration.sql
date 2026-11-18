CREATE TABLE `gateway_change_records` (
	`sequence` integer PRIMARY KEY AUTOINCREMENT,
	`id` text NOT NULL,
	`organization_id` text NOT NULL,
	`resource` text NOT NULL,
	`actor_id` text NOT NULL,
	`recorded_at` text NOT NULL,
	`record` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_gateway_change_records_id` ON `gateway_change_records` (`id`);--> statement-breakpoint
CREATE INDEX `idx_gateway_change_records_org_sequence` ON `gateway_change_records` (`organization_id`,`sequence`);