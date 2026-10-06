ALTER TABLE `organizations` ADD `stripe_environment` text;--> statement-breakpoint
ALTER TABLE `billing_accounts` ADD `stripe_environment` text;--> statement-breakpoint
ALTER TABLE `stripe_meter_outbox` ADD `stripe_environment` text DEFAULT 'live' NOT NULL;--> statement-breakpoint
UPDATE `organizations`
SET `stripe_environment` = 'live'
WHERE `stripe_customer_id` IS NOT NULL;--> statement-breakpoint
UPDATE `billing_accounts`
SET `stripe_environment` = 'live'
WHERE `billing_mode` = 'stripe';--> statement-breakpoint
CREATE INDEX `idx_org_stripe_environment` ON `organizations` (`stripe_environment`);--> statement-breakpoint
CREATE INDEX `idx_billing_account_stripe_environment` ON `billing_accounts` (`stripe_environment`);--> statement-breakpoint
DROP INDEX `idx_stripe_meter_outbox_retry`;--> statement-breakpoint
CREATE INDEX `idx_stripe_meter_outbox_retry` ON `stripe_meter_outbox` (`stripe_environment`,`status`,`next_attempt_at`,`lease_expires_at`);
