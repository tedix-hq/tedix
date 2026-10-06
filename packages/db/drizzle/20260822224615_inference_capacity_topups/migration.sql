CREATE TABLE `billing_inference_capacity_grants` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`pack_version_id` text NOT NULL,
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
	CONSTRAINT `fk_billing_inference_capacity_grants_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_billing_inference_capacity_grants_pack_version_id_billing_inference_capacity_pack_versions_id_fk` FOREIGN KEY (`pack_version_id`) REFERENCES `billing_inference_capacity_pack_versions`(`id`),
	CONSTRAINT "chk_billing_inference_capacity_positive" CHECK("token_amount" > 0 AND "spend_amount_micros" > 0)
);
--> statement-breakpoint
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
	`stripe_price_id` text,
	`stripe_lookup_key` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`effective_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT "chk_inference_capacity_pack_positive" CHECK("price_micros" > 0 AND "token_amount" > 0 AND "spend_amount_micros" > 0),
	CONSTRAINT "chk_inference_capacity_pack_stripe_identifier" CHECK("stripe_price_id" IS NOT NULL OR "stripe_lookup_key" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_inference_capacity_idempotency` ON `billing_inference_capacity_grants` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_billing_inference_capacity_active` ON `billing_inference_capacity_grants` (`organization_id`,`stripe_environment`,`budget_day`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inference_capacity_pack_version` ON `billing_inference_capacity_pack_versions` (`pack_key`,`version`,`stripe_environment`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inference_capacity_pack_lookup` ON `billing_inference_capacity_pack_versions` (`stripe_environment`,`stripe_lookup_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_inference_capacity_pack_price` ON `billing_inference_capacity_pack_versions` (`stripe_environment`,`stripe_price_id`);--> statement-breakpoint
CREATE INDEX `idx_inference_capacity_pack_active` ON `billing_inference_capacity_pack_versions` (`stripe_environment`,`status`,`effective_at`);--> statement-breakpoint
CREATE TRIGGER `billing_inference_capacity_grants_immutable`
BEFORE UPDATE ON `billing_inference_capacity_grants`
BEGIN
	SELECT RAISE(ABORT, 'billing inference capacity grants are append-only');
END;--> statement-breakpoint
CREATE TRIGGER `billing_inference_capacity_pack_versions_immutable`
BEFORE UPDATE ON `billing_inference_capacity_pack_versions`
BEGIN
	SELECT RAISE(ABORT, 'billing inference capacity pack versions are immutable');
END;--> statement-breakpoint
INSERT INTO `billing_inference_capacity_pack_versions` (
	`id`, `pack_key`, `version`, `status`, `name`, `currency`,
	`price_micros`, `token_amount`, `spend_amount_micros`,
	`stripe_environment`, `stripe_price_id`, `stripe_lookup_key`,
	`metadata`, `effective_at`, `created_at`
) VALUES (
	'inference-capacity-daily-5m-test-v1',
	'daily_5m',
	1,
	'active',
	'5M daily boost',
	'usd',
	25000000,
	5000000,
	25000000,
	'test',
	NULL,
	'tedix_inference_capacity_daily_5m_v1',
	'{}',
	'2026-08-22T22:46:15.000Z',
	'2026-08-22T22:46:15.000Z'
);
