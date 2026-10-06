ALTER TABLE `billing_accounts` ADD `stripe_customer_id` text;--> statement-breakpoint
ALTER TABLE `billing_accounts` ADD `stripe_subscription_id` text;--> statement-breakpoint
ALTER TABLE `billing_accounts` ADD `stripe_cancel_at_period_end` integer;--> statement-breakpoint
UPDATE `billing_accounts`
SET
	`stripe_environment` = COALESCE(
		`stripe_environment`,
		(SELECT `stripe_environment` FROM `organizations` WHERE `organizations`.`id` = `billing_accounts`.`organization_id`),
		'live'
	),
	`stripe_customer_id` = (
		SELECT `stripe_customer_id` FROM `organizations` WHERE `organizations`.`id` = `billing_accounts`.`organization_id`
	),
	`stripe_subscription_id` = (
		SELECT `stripe_subscription_id` FROM `organizations` WHERE `organizations`.`id` = `billing_accounts`.`organization_id`
	),
	`stripe_cancel_at_period_end` = CASE
		WHEN (SELECT `stripe_subscription_id` FROM `organizations` WHERE `organizations`.`id` = `billing_accounts`.`organization_id`) IS NOT NULL THEN 0
		ELSE NULL
	END
WHERE EXISTS (
	SELECT 1
	FROM `organizations`
	WHERE `organizations`.`id` = `billing_accounts`.`organization_id`
		AND (
			`organizations`.`stripe_customer_id` IS NOT NULL
			OR `organizations`.`stripe_subscription_id` IS NOT NULL
		)
);--> statement-breakpoint
DROP INDEX IF EXISTS `idx_org_status`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_org_stripe_customer`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_org_stripe_environment`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_account_stripe_customer` ON `billing_accounts` (`stripe_environment`,`stripe_customer_id`) WHERE "billing_accounts"."stripe_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_account_stripe_subscription` ON `billing_accounts` (`stripe_environment`,`stripe_subscription_id`) WHERE "billing_accounts"."stripe_subscription_id" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `organizations` DROP COLUMN `subscription_status`;--> statement-breakpoint
ALTER TABLE `organizations` DROP COLUMN `subscription_tier`;--> statement-breakpoint
ALTER TABLE `organizations` DROP COLUMN `stripe_customer_id`;--> statement-breakpoint
ALTER TABLE `organizations` DROP COLUMN `stripe_subscription_id`;--> statement-breakpoint
ALTER TABLE `organizations` DROP COLUMN `stripe_environment`;--> statement-breakpoint
ALTER TABLE `organizations` DROP COLUMN `trial_ends_at`;
