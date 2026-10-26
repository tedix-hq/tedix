CREATE TABLE `connection_connect_tickets` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`scope` text NOT NULL,
	`connection_instance_id` text,
	`ticket_hash` text NOT NULL,
	`status` text DEFAULT 'staged' NOT NULL,
	`expires_at` text NOT NULL,
	`created_at` text NOT NULL,
	`redeemed_at` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `connection_connect_tickets_hash_idx` ON `connection_connect_tickets` (`ticket_hash`);--> statement-breakpoint
CREATE INDEX `connection_connect_tickets_user_idx` ON `connection_connect_tickets` (`organization_id`,`user_id`);