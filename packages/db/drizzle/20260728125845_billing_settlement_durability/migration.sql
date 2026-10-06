CREATE TABLE `billing_provider_usage` (
	`id` text PRIMARY KEY,
	`organization_id` text,
	`tedi_id` text,
	`reservation_id` text,
	`gateway_log_id` text,
	`provider_usage_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`usage_kind` text NOT NULL,
	`unit` text NOT NULL,
	`quantity` integer NOT NULL,
	`provider_cost_micros` integer DEFAULT 0 NOT NULL,
	`provider_cost_quality` text DEFAULT 'estimated' NOT NULL,
	`customer_metering_ready` integer DEFAULT false NOT NULL,
	`occurred_at` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `billing_usage_quarantines` (
	`id` text PRIMARY KEY,
	`gateway_log_id` text NOT NULL,
	`organization_id` text,
	`reason` text NOT NULL,
	`source_snapshot_at` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `stripe_webhook_events` (
	`event_id` text PRIMARY KEY,
	`event_type` text NOT NULL,
	`entity_key` text NOT NULL,
	`event_created_at` integer NOT NULL,
	`status` text DEFAULT 'processing' NOT NULL,
	`attempt_count` integer DEFAULT 1 NOT NULL,
	`lease_expires_at` text,
	`outcome` text,
	`last_error` text,
	`processed_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
ALTER TABLE `tedi_call_costs` ADD `usage_kind` text;--> statement-breakpoint
ALTER TABLE `tedi_call_costs` ADD `usage_unit` text;--> statement-breakpoint
ALTER TABLE `tedi_call_costs` ADD `usage_quantity` integer;--> statement-breakpoint
ALTER TABLE `billing_usage_periods` ADD `settlement_version` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `billing_usage_periods` ADD `last_settlement_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_provider_usage_gateway_log` ON `billing_provider_usage` (`gateway_log_id`) WHERE "billing_provider_usage"."gateway_log_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_provider_usage_provider_id` ON `billing_provider_usage` (`provider_usage_id`) WHERE "billing_provider_usage"."provider_usage_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_billing_provider_usage_org_occurred` ON `billing_provider_usage` (`organization_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_billing_provider_usage_kind_occurred` ON `billing_provider_usage` (`usage_kind`,`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_usage_quarantine_gateway_log` ON `billing_usage_quarantines` (`gateway_log_id`);--> statement-breakpoint
CREATE INDEX `idx_billing_usage_quarantine_reason_created` ON `billing_usage_quarantines` (`reason`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_stripe_webhook_entity_created` ON `stripe_webhook_events` (`entity_key`,`event_created_at`);--> statement-breakpoint
CREATE INDEX `idx_stripe_webhook_status_lease` ON `stripe_webhook_events` (`status`,`lease_expires_at`);