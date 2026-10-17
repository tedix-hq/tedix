CREATE TABLE `support_configuration` (
	`id` text PRIMARY KEY,
	`configuration` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `support_tickets` (
	`id` text PRIMARY KEY,
	`org_id` text NOT NULL,
	`platform_org_id` text NOT NULL,
	`reporter_key` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`work_item_id` text NOT NULL,
	`mirror_work_item_id` text NOT NULL,
	`project_id` text NOT NULL,
	`report` text NOT NULL,
	`consent_reference` text NOT NULL,
	`payload_digest` text NOT NULL,
	`status` text DEFAULT 'received' NOT NULL,
	`mirror_delivery` text DEFAULT 'pending' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`draft` text,
	`public_updates` text DEFAULT '[]' NOT NULL,
	`reporter_verification` text DEFAULT 'unconfirmed' NOT NULL,
	`update_keys` text DEFAULT '[]' NOT NULL,
	`next_update_due` text NOT NULL,
	`escalation_work_item_id` text,
	`interaction_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `support_tickets_org_key` ON `support_tickets` (`org_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `support_tickets_org_reporter` ON `support_tickets` (`org_id`,`reporter_key`);--> statement-breakpoint
CREATE INDEX `support_tickets_platform_due` ON `support_tickets` (`platform_org_id`,`next_update_due`);