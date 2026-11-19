CREATE TABLE `billing_credit_notice_deliveries` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`period_start` text NOT NULL,
	`threshold` integer NOT NULL,
	`channel` text NOT NULL,
	`recipient_user_id` text NOT NULL,
	`recipient_email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_expires_at` text,
	`delivery_ref` text,
	`last_error` text,
	`sent_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_credit_notice_deliveries_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_billing_credit_notice_delivery_threshold" CHECK("threshold" IN (80, 100))
);
--> statement-breakpoint
ALTER TABLE `billing_credit_notices` ADD `deliveries_planned_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_credit_notice_delivery` ON `billing_credit_notice_deliveries` (`organization_id`,`period_start`,`threshold`,`channel`,`recipient_user_id`);--> statement-breakpoint
CREATE INDEX `idx_billing_credit_notice_delivery_retry` ON `billing_credit_notice_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE INDEX `idx_billing_credit_notices_unplanned` ON `billing_credit_notices` (`reached_at`) WHERE "billing_credit_notices"."deliveries_planned_at" IS NULL;