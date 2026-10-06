-- tedix: destructive-reviewed Work-Item: da69dc69-b5f9-45e9-8fbe-2629f2272fc3
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__old_billing_inference_capacity_pack_versions` AS SELECT `id`, `pack_key`, `version`, `status`, `name`, `currency`, `price_micros`, `token_amount`, `spend_amount_micros`, `stripe_environment`, `stripe_lookup_key`, `metadata`, `effective_at`, `created_at` FROM `billing_inference_capacity_pack_versions`;--> statement-breakpoint
DROP TABLE `billing_inference_capacity_pack_versions`;--> statement-breakpoint
CREATE TABLE `billing_inference_capacity_pack_versions` (
	`id` text PRIMARY KEY,
	`pack_key` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`name` text NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`price_micros` integer NOT NULL,
	`token_amount` integer NOT NULL,
	`spend_amount_micros` integer NOT NULL,
	`stripe_environment` text NOT NULL,
	`stripe_lookup_key` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`effective_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT "chk_inference_capacity_pack_positive" CHECK("price_micros" > 0 AND "token_amount" > 0 AND "spend_amount_micros" > 0)
);
--> statement-breakpoint
INSERT INTO `billing_inference_capacity_pack_versions`(`id`, `pack_key`, `version`, `status`, `name`, `currency`, `price_micros`, `token_amount`, `spend_amount_micros`, `stripe_environment`, `stripe_lookup_key`, `metadata`, `effective_at`, `created_at`) SELECT `id`, `pack_key`, `version`, `status`, `name`, `currency`, `price_micros`, `token_amount`, `spend_amount_micros`, `stripe_environment`, `stripe_lookup_key`, `metadata`, `effective_at`, `created_at` FROM `__old_billing_inference_capacity_pack_versions`;--> statement-breakpoint
DROP TABLE `__old_billing_inference_capacity_pack_versions`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inference_capacity_pack_version` ON `billing_inference_capacity_pack_versions` (`pack_key`,`version`,`stripe_environment`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inference_capacity_pack_lookup` ON `billing_inference_capacity_pack_versions` (`stripe_environment`,`stripe_lookup_key`);--> statement-breakpoint
CREATE INDEX `idx_inference_capacity_pack_active` ON `billing_inference_capacity_pack_versions` (`stripe_environment`,`status`,`effective_at`);--> statement-breakpoint
CREATE TRIGGER `billing_inference_capacity_pack_versions_immutable`
BEFORE UPDATE ON `billing_inference_capacity_pack_versions`
BEGIN
	SELECT RAISE(ABORT, 'billing inference capacity pack versions are immutable');
END;--> statement-breakpoint
ALTER TABLE `billing_plan_versions` DROP COLUMN `stripe_product_id`;--> statement-breakpoint
ALTER TABLE `billing_plan_versions` DROP COLUMN `stripe_monthly_price_id`;--> statement-breakpoint
ALTER TABLE `billing_plan_versions` DROP COLUMN `stripe_annual_price_id`;--> statement-breakpoint
ALTER TABLE `billing_plan_versions` DROP COLUMN `stripe_overage_price_id`;