CREATE TABLE `billing_capacity_allocations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`pack_version_id` text,
	`budget_day` text NOT NULL,
	`token_amount` integer DEFAULT 0 NOT NULL,
	`spend_amount_micros` integer DEFAULT 0 NOT NULL,
	`source_type` text NOT NULL,
	`source_ref` text,
	`idempotency_key` text NOT NULL,
	`stripe_environment` text NOT NULL,
	`expires_at` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_capacity_allocations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_billing_capacity_allocations_pack_version_id_billing_inference_capacity_pack_versions_id_fk` FOREIGN KEY (`pack_version_id`) REFERENCES `billing_inference_capacity_pack_versions`(`id`),
	CONSTRAINT "chk_billing_capacity_allocation_positive" CHECK("token_amount" > 0 OR "spend_amount_micros" > 0)
);
--> statement-breakpoint
CREATE TABLE `billing_inference_policies` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`scope` text NOT NULL,
	`subject_key` text NOT NULL,
	`tedi_id` text,
	`allowed_model_tiers` text,
	`daily_token_limit` integer,
	`daily_spend_limit_micros` integer,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_inference_policies_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_billing_inference_policies_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE CASCADE,
	CONSTRAINT "chk_billing_inference_policy_subject" CHECK(("scope" = 'organization' AND "subject_key" = 'organization' AND "tedi_id" IS NULL) OR ("scope" = 'tedi' AND "subject_key" = "tedi_id" AND "tedi_id" IS NOT NULL)),
	CONSTRAINT "chk_billing_inference_policy_limits" CHECK(("daily_token_limit" IS NULL OR "daily_token_limit" >= 0) AND ("daily_spend_limit_micros" IS NULL OR "daily_spend_limit_micros" >= 0))
);
--> statement-breakpoint
INSERT INTO `billing_inference_policies` (
	`id`, `organization_id`, `scope`, `subject_key`, `tedi_id`,
	`allowed_model_tiers`, `daily_token_limit`, `daily_spend_limit_micros`
)
SELECT
	'org:' || `id`, `id`, 'organization', 'organization', NULL,
	json_extract(`metadata`, '$.aiGatewayPolicy.allowedModelTiers'),
	json_extract(`metadata`, '$.aiGatewayPolicy.dailyTokenLimit'),
	json_extract(`metadata`, '$.aiGatewayPolicy.dailySpendLimitMicros')
FROM `organizations`
WHERE json_type(`metadata`, '$.aiGatewayPolicy') = 'object';--> statement-breakpoint
INSERT INTO `billing_inference_policies` (
	`id`, `organization_id`, `scope`, `subject_key`, `tedi_id`,
	`allowed_model_tiers`, `daily_token_limit`, `daily_spend_limit_micros`
)
SELECT
	'tedi:' || `id`, `organization_id`, 'tedi', `id`, `id`,
	json_extract(`budgets`, '$.aiGatewayPolicy.allowedModelTiers'),
	json_extract(`budgets`, '$.aiGatewayPolicy.dailyTokenLimit'),
	json_extract(`budgets`, '$.aiGatewayPolicy.dailySpendLimitMicros')
FROM `tedis`
WHERE json_type(`budgets`, '$.aiGatewayPolicy') = 'object';--> statement-breakpoint
UPDATE `organizations`
SET `metadata` = json_remove(`metadata`, '$.aiGatewayPolicy')
WHERE json_type(`metadata`, '$.aiGatewayPolicy') IS NOT NULL;--> statement-breakpoint
UPDATE `tedis`
SET `budgets` = json_remove(`budgets`, '$.aiGatewayPolicy')
WHERE json_type(`budgets`, '$.aiGatewayPolicy') IS NOT NULL;--> statement-breakpoint
INSERT INTO `billing_capacity_allocations` SELECT * FROM `billing_inference_capacity_grants`;--> statement-breakpoint
DROP INDEX IF EXISTS `uniq_billing_inference_capacity_idempotency`;--> statement-breakpoint
DROP INDEX IF EXISTS `idx_billing_inference_capacity_active`;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_capacity_allocation_idempotency` ON `billing_capacity_allocations` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_billing_capacity_allocation_active` ON `billing_capacity_allocations` (`organization_id`,`stripe_environment`,`budget_day`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_inference_policy_subject` ON `billing_inference_policies` (`organization_id`,`scope`,`subject_key`);--> statement-breakpoint
CREATE INDEX `idx_billing_inference_policy_tedi` ON `billing_inference_policies` (`tedi_id`);--> statement-breakpoint
DROP TABLE `billing_inference_capacity_grants`;
--> statement-breakpoint
CREATE TRIGGER `billing_capacity_allocations_update_immutable`
BEFORE UPDATE ON `billing_capacity_allocations`
BEGIN
	SELECT RAISE(ABORT, 'billing capacity allocations are append-only');
END;--> statement-breakpoint
CREATE TRIGGER `billing_capacity_allocations_delete_immutable`
BEFORE DELETE ON `billing_capacity_allocations`
BEGIN
	SELECT RAISE(ABORT, 'billing capacity allocations are append-only');
END;--> statement-breakpoint
INSERT INTO `billing_inference_capacity_pack_versions` (
	`id`, `pack_key`, `version`, `status`, `name`, `currency`,
	`price_micros`, `token_amount`, `spend_amount_micros`,
	`stripe_environment`, `stripe_price_id`, `stripe_lookup_key`,
	`metadata`, `effective_at`, `created_at`
) VALUES (
	'inference-capacity-daily-5m-live-v1',
	'daily_5m',
	1,
	'active',
	'5M daily boost',
	'usd',
	25000000,
	5000000,
	25000000,
	'live',
	NULL,
	'tedix_inference_capacity_daily_5m_v1',
	'{}',
	'2026-08-23T20:21:11.000Z',
	'2026-08-23T20:21:11.000Z'
);
