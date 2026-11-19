-- tedix: destructive-reviewed Work-Item: b035a564-f807-4db6-8f42-8e197bda081e
-- Tedix credits replace token plans and every daily limit (owner approval
-- 19 Nov 2026). The backfill migration before this one converted what these
-- objects held: wallet balances and unexpired SEO credits became top-up
-- credits, and policy rows that held only daily limits were removed. The
-- dropped tables held daily capacity packs and allocations (live: one
-- operator grant from 1 Sep), the EUR wallet journal, per-plan SEO
-- allowances, the SEO credit journal, and the token meter outbox (test mode
-- only). billing_inference_policies is rebuilt without its daily columns; it
-- has no child tables.
PRAGMA defer_foreign_keys = true;--> statement-breakpoint
CREATE TABLE `__new_billing_inference_policies` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`scope` text NOT NULL,
	`subject_key` text NOT NULL,
	`tedi_id` text,
	`allowed_model_tiers` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_inference_policies_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_billing_inference_policies_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_billing_inference_policy_subject" CHECK(("scope" = 'organization' AND "subject_key" = 'organization' AND "tedi_id" IS NULL) OR ("scope" = 'tedi' AND "subject_key" = "tedi_id" AND "tedi_id" IS NOT NULL))
);
--> statement-breakpoint
INSERT INTO `__new_billing_inference_policies`(`id`, `organization_id`, `scope`, `subject_key`, `tedi_id`, `allowed_model_tiers`, `created_at`, `updated_at`) SELECT `id`, `organization_id`, `scope`, `subject_key`, `tedi_id`, `allowed_model_tiers`, `created_at`, `updated_at` FROM `billing_inference_policies`;--> statement-breakpoint
DROP TABLE `billing_inference_policies`;--> statement-breakpoint
ALTER TABLE `__new_billing_inference_policies` RENAME TO `billing_inference_policies`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_billing_capacity_allocation_idempotency`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_billing_capacity_allocation_active`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_billing_credit_idempotency`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_billing_credit_org_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_billing_credit_expiry`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_inference_capacity_pack_version`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_inference_capacity_pack_lookup`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_inference_capacity_pack_active`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_billing_plan_service_allowance`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_billing_service_credit_idempotency`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_billing_service_credit_org_service_created`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_billing_service_credit_expiry`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_stripe_meter_outbox_idempotency`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_stripe_meter_outbox_charge`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_stripe_meter_outbox_retry`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_inference_policy_subject` ON `billing_inference_policies` (`organization_id`,`scope`,`subject_key`);--> statement-breakpoint
CREATE INDEX `idx_billing_inference_policy_tedi` ON `billing_inference_policies` (`tedi_id`);--> statement-breakpoint
DROP TABLE `billing_capacity_allocations`;--> statement-breakpoint
DROP TABLE `billing_credit_entries`;--> statement-breakpoint
DROP TABLE `billing_inference_capacity_pack_versions`;--> statement-breakpoint
DROP TABLE `billing_plan_service_allowances`;--> statement-breakpoint
DROP TABLE `billing_service_credit_entries`;--> statement-breakpoint
DROP TABLE `stripe_meter_outbox`;--> statement-breakpoint
ALTER TABLE `billing_accounts` DROP COLUMN `credit_balance_micros`;--> statement-breakpoint
ALTER TABLE `billing_plan_versions` DROP COLUMN `included_monthly_tokens`;--> statement-breakpoint
ALTER TABLE `billing_plan_versions` DROP COLUMN `included_monthly_credit_micros`;--> statement-breakpoint
ALTER TABLE `billing_plan_versions` DROP COLUMN `overage_unit_tokens`;--> statement-breakpoint
ALTER TABLE `billing_plan_versions` DROP COLUMN `overage_unit_price_micros`;--> statement-breakpoint
ALTER TABLE `billing_plan_versions` DROP COLUMN `default_daily_token_limit`;--> statement-breakpoint
ALTER TABLE `billing_plan_versions` DROP COLUMN `default_daily_message_limit`;--> statement-breakpoint
ALTER TABLE `billing_usage_periods` DROP COLUMN `included_tokens`;--> statement-breakpoint
ALTER TABLE `billing_usage_periods` DROP COLUMN `metered_overage_tokens`;--> statement-breakpoint
ALTER TABLE `billing_usage_periods` DROP COLUMN `customer_charge_micros`;--> statement-breakpoint
ALTER TABLE `billing_usage_periods` DROP COLUMN `credit_applied_micros`;