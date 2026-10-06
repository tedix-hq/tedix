CREATE TABLE `billing_plan_service_allowances` (
	`id` text PRIMARY KEY,
	`plan_version_id` text NOT NULL,
	`service_key` text NOT NULL,
	`included_credits` integer NOT NULL,
	`per_tedi_monthly_limit` integer,
	`monthly_provider_cost_limit_micros` integer,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_plan_service_allowances_plan_version_id_billing_plan_versions_id_fk` FOREIGN KEY (`plan_version_id`) REFERENCES `billing_plan_versions`(`id`)
);
--> statement-breakpoint
CREATE TABLE `billing_service_credit_controls` (
	`organization_id` text NOT NULL,
	`service_key` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`monthly_credit_limit` integer,
	`per_tedi_monthly_limit` integer,
	`monthly_provider_cost_limit_micros` integer,
	`updated_by` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_service_credit_controls_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `billing_service_credit_entries` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`service_key` text NOT NULL,
	`kind` text NOT NULL,
	`amount_credits` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_ref` text,
	`reservation_id` text,
	`idempotency_key` text NOT NULL,
	`expires_at` text,
	`description` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_service_credit_entries_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `billing_service_credit_reservations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`plan_version_id` text NOT NULL,
	`rate_card_id` text NOT NULL,
	`tedi_id` text,
	`service_key` text NOT NULL,
	`operation_key` text NOT NULL,
	`status` text DEFAULT 'reserved' NOT NULL,
	`credits_reserved` integer NOT NULL,
	`customer_value_micros` integer NOT NULL,
	`provider_cost_ceiling_micros` integer NOT NULL,
	`actual_provider_cost_micros` integer,
	`provider_usage_id` text,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`rejection_code` text,
	`expires_at` text NOT NULL,
	`settled_at` text,
	`released_at` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_service_credit_reservations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_billing_service_credit_reservations_plan_version_id_billing_plan_versions_id_fk` FOREIGN KEY (`plan_version_id`) REFERENCES `billing_plan_versions`(`id`),
	CONSTRAINT `fk_billing_service_credit_reservations_rate_card_id_billing_service_rate_cards_id_fk` FOREIGN KEY (`rate_card_id`) REFERENCES `billing_service_rate_cards`(`id`),
	CONSTRAINT `fk_billing_service_credit_reservations_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `billing_service_rate_cards` (
	`id` text PRIMARY KEY,
	`service_key` text NOT NULL,
	`operation_key` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`provider` text NOT NULL,
	`provider_endpoint` text NOT NULL,
	`credit_cost` integer NOT NULL,
	`customer_value_micros` integer NOT NULL,
	`provider_cost_ceiling_micros` integer NOT NULL,
	`effective_at` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_plan_service_allowance` ON `billing_plan_service_allowances` (`plan_version_id`,`service_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_service_credit_control` ON `billing_service_credit_controls` (`organization_id`,`service_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_service_credit_idempotency` ON `billing_service_credit_entries` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_billing_service_credit_org_service_created` ON `billing_service_credit_entries` (`organization_id`,`service_key`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_billing_service_credit_expiry` ON `billing_service_credit_entries` (`organization_id`,`service_key`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_service_reservation_idempotency` ON `billing_service_credit_reservations` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_service_reservation_provider_usage` ON `billing_service_credit_reservations` (`provider_usage_id`) WHERE "billing_service_credit_reservations"."provider_usage_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_billing_service_reservation_org_status` ON `billing_service_credit_reservations` (`organization_id`,`service_key`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_billing_service_reservation_tedi_period` ON `billing_service_credit_reservations` (`tedi_id`,`service_key`,`period_start`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_service_rate_card_version` ON `billing_service_rate_cards` (`service_key`,`operation_key`,`version`);--> statement-breakpoint
CREATE INDEX `idx_billing_service_rate_card_active` ON `billing_service_rate_cards` (`service_key`,`operation_key`,`status`,`effective_at`);
--> statement-breakpoint
INSERT INTO billing_service_rate_cards (
	id, service_key, operation_key, version, status, provider,
	provider_endpoint, credit_cost, customer_value_micros,
	provider_cost_ceiling_micros, effective_at, metadata
) VALUES
	(
		'seo-research-keywords-v1', 'seo', 'research_keywords', 1, 'active',
		'dataforseo', '/v3/dataforseo_labs/google/keyword_suggestions/live',
		4, 10000, 30000, '2026-07-30T00:00:00.000Z',
		'{"pricingVersion":"seo-v1","providerPricingCheckedAt":"2026-07-29"}'
	),
	(
		'seo-serp-results-v1', 'seo', 'get_serp_results', 1, 'active',
		'dataforseo', '/v3/serp/google/organic/live/advanced',
		3, 10000, 25000, '2026-07-30T00:00:00.000Z',
		'{"pricingVersion":"seo-v1","providerPricingCheckedAt":"2026-07-29"}'
	),
	(
		'seo-domain-overview-v1', 'seo', 'get_domain_overview', 1, 'active',
		'dataforseo', '/v3/dataforseo_labs/google/domain_rank_overview/live',
		2, 10000, 20000, '2026-07-30T00:00:00.000Z',
		'{"pricingVersion":"seo-v1","providerPricingCheckedAt":"2026-07-29"}'
	),
	(
		'seo-backlinks-overview-v1', 'seo', 'get_backlinks_overview', 1, 'active',
		'dataforseo', '/v3/backlinks/summary/live',
		4, 10000, 30000, '2026-07-30T00:00:00.000Z',
		'{"pricingVersion":"seo-v1","providerPricingCheckedAt":"2026-07-29"}'
	);
--> statement-breakpoint
INSERT INTO billing_plan_service_allowances (
	id, plan_version_id, service_key, included_credits,
	per_tedi_monthly_limit, monthly_provider_cost_limit_micros
)
SELECT
	'seo-allowance-' || plan.id,
	plan.id,
	'seo',
	CASE plan.plan_key
		WHEN 'starter' THEN 25
		WHEN 'growth' THEN 500
		WHEN 'business' THEN 2000
		WHEN 'enterprise' THEN 10000
	END,
	CASE plan.plan_key
		WHEN 'starter' THEN 25
		WHEN 'growth' THEN 500
		WHEN 'business' THEN 1000
		WHEN 'enterprise' THEN 2500
	END,
	CASE plan.plan_key
		WHEN 'starter' THEN 500000
		WHEN 'growth' THEN 10000000
		WHEN 'business' THEN 40000000
		WHEN 'enterprise' THEN 200000000
	END
FROM billing_plan_versions AS plan
WHERE plan.plan_key IN ('starter', 'growth', 'business', 'enterprise')
ON CONFLICT(plan_version_id, service_key) DO NOTHING;
--> statement-breakpoint
CREATE TRIGGER billing_service_credit_entries_nonzero
BEFORE INSERT ON billing_service_credit_entries
WHEN NEW.amount_credits = 0
BEGIN
	SELECT RAISE(ABORT, 'billing service credit entry must be non-zero');
END;
--> statement-breakpoint
CREATE TRIGGER billing_service_credit_entries_positive_kind
BEFORE INSERT ON billing_service_credit_entries
WHEN NEW.kind IN ('grant', 'refund') AND NEW.amount_credits < 0
BEGIN
	SELECT RAISE(ABORT, 'billing service grant/refund must be positive');
END;
--> statement-breakpoint
CREATE TRIGGER billing_service_credit_entries_debit_kind
BEFORE INSERT ON billing_service_credit_entries
WHEN NEW.kind = 'debit' AND NEW.amount_credits > 0
BEGIN
	SELECT RAISE(ABORT, 'billing service debit must be negative');
END;
--> statement-breakpoint
CREATE TRIGGER billing_service_credit_entries_immutable_update
BEFORE UPDATE ON billing_service_credit_entries
BEGIN
	SELECT RAISE(ABORT, 'billing service credit journal is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER billing_service_credit_entries_immutable_delete
BEFORE DELETE ON billing_service_credit_entries
BEGIN
	SELECT RAISE(ABORT, 'billing service credit journal is immutable');
END;
