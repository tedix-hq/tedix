CREATE TABLE `connection_instances` (
	`id` text PRIMARY KEY,
	`owner_user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`label` text NOT NULL,
	`token_ids` text NOT NULL,
	`token_sub` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `connection_instances_owner_provider_idx` ON `connection_instances` (`owner_user_id`,`provider_id`);