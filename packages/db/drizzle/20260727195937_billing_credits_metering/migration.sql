CREATE TABLE `billing_accounts` (
	`organization_id` text PRIMARY KEY,
	`plan_version_id` text NOT NULL,
	`status` text DEFAULT 'trial' NOT NULL,
	`billing_mode` text DEFAULT 'trial' NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`hard_spend_limit_micros` integer,
	`credit_balance_micros` integer DEFAULT 0 NOT NULL,
	`grace_ends_at` text,
	`entitlement_version` integer DEFAULT 1 NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_accounts_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_billing_accounts_plan_version_id_billing_plan_versions_id_fk` FOREIGN KEY (`plan_version_id`) REFERENCES `billing_plan_versions`(`id`)
);
--> statement-breakpoint
CREATE TABLE `billing_credit_entries` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`kind` text NOT NULL,
	`amount_micros` integer NOT NULL,
	`source_type` text NOT NULL,
	`source_ref` text,
	`usage_charge_id` text,
	`idempotency_key` text NOT NULL,
	`expires_at` text,
	`description` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_credit_entries_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `billing_plan_versions` (
	`id` text PRIMARY KEY,
	`plan_key` text NOT NULL,
	`version` integer NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`name` text NOT NULL,
	`currency` text DEFAULT 'usd' NOT NULL,
	`monthly_price_micros` integer DEFAULT 0 NOT NULL,
	`annual_price_micros` integer DEFAULT 0 NOT NULL,
	`included_monthly_tokens` integer NOT NULL,
	`included_monthly_credit_micros` integer DEFAULT 0 NOT NULL,
	`overage_unit_tokens` integer DEFAULT 1000 NOT NULL,
	`overage_unit_price_micros` integer DEFAULT 0 NOT NULL,
	`max_tedis` integer NOT NULL,
	`max_cron_jobs_per_tedi` integer NOT NULL,
	`max_iterations_per_task` integer NOT NULL,
	`default_daily_token_limit` integer NOT NULL,
	`default_daily_message_limit` integer NOT NULL,
	`allow_overage` integer DEFAULT false NOT NULL,
	`stripe_product_id` text,
	`stripe_monthly_price_id` text,
	`stripe_annual_price_id` text,
	`stripe_overage_price_id` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`effective_at` text NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `billing_usage_charges` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text,
	`reservation_id` text,
	`usage_period_id` text NOT NULL,
	`gateway_log_id` text,
	`provider_usage_id` text,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`source` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`included_tokens_applied` integer DEFAULT 0 NOT NULL,
	`metered_overage_tokens` integer DEFAULT 0 NOT NULL,
	`provider_cost_micros` integer DEFAULT 0 NOT NULL,
	`customer_charge_micros` integer DEFAULT 0 NOT NULL,
	`credit_applied_micros` integer DEFAULT 0 NOT NULL,
	`usage_quality` text DEFAULT 'gateway_reported' NOT NULL,
	`provider_cost_quality` text DEFAULT 'estimated' NOT NULL,
	`metering_ready` integer DEFAULT false NOT NULL,
	`provider_reconciled_at` text,
	`rate_card_version` text,
	`occurred_at` text NOT NULL,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_usage_charges_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_billing_usage_charges_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_billing_usage_charges_reservation_id_billing_usage_reservations_id_fk` FOREIGN KEY (`reservation_id`) REFERENCES `billing_usage_reservations`(`id`) ON DELETE SET NULL,
	CONSTRAINT `fk_billing_usage_charges_usage_period_id_billing_usage_periods_id_fk` FOREIGN KEY (`usage_period_id`) REFERENCES `billing_usage_periods`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `billing_usage_periods` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`plan_version_id` text NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`included_tokens` integer NOT NULL,
	`used_input_tokens` integer DEFAULT 0 NOT NULL,
	`used_output_tokens` integer DEFAULT 0 NOT NULL,
	`metered_overage_tokens` integer DEFAULT 0 NOT NULL,
	`provider_cost_micros` integer DEFAULT 0 NOT NULL,
	`customer_charge_micros` integer DEFAULT 0 NOT NULL,
	`credit_applied_micros` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_usage_periods_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_billing_usage_periods_plan_version_id_billing_plan_versions_id_fk` FOREIGN KEY (`plan_version_id`) REFERENCES `billing_plan_versions`(`id`)
);
--> statement-breakpoint
CREATE TABLE `billing_usage_reservations` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`tedi_id` text,
	`status` text DEFAULT 'reserved' NOT NULL,
	`source` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`estimated_input_tokens` integer DEFAULT 0 NOT NULL,
	`estimated_output_tokens` integer DEFAULT 0 NOT NULL,
	`estimated_charge_micros` integer DEFAULT 0 NOT NULL,
	`period_start` text NOT NULL,
	`period_end` text NOT NULL,
	`run_id` text,
	`trace_id` text,
	`idempotency_key` text NOT NULL,
	`rejection_code` text,
	`expires_at` text NOT NULL,
	`settled_at` text,
	`released_at` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_billing_usage_reservations_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_billing_usage_reservations_tedi_id_tedis_id_fk` FOREIGN KEY (`tedi_id`) REFERENCES `tedis`(`id`) ON DELETE SET NULL
);
--> statement-breakpoint
CREATE TABLE `stripe_meter_outbox` (
	`id` text PRIMARY KEY,
	`organization_id` text NOT NULL,
	`usage_charge_id` text NOT NULL,
	`stripe_customer_id` text NOT NULL,
	`event_name` text NOT NULL,
	`quantity` integer NOT NULL,
	`idempotency_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`next_attempt_at` text NOT NULL,
	`lease_expires_at` text,
	`stripe_event_id` text,
	`last_error` text,
	`sent_at` text,
	`created_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	`updated_at` text DEFAULT (CURRENT_TIMESTAMP) NOT NULL,
	CONSTRAINT `fk_stripe_meter_outbox_organization_id_organizations_id_fk` FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_stripe_meter_outbox_usage_charge_id_billing_usage_charges_id_fk` FOREIGN KEY (`usage_charge_id`) REFERENCES `billing_usage_charges`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `idx_billing_account_status` ON `billing_accounts` (`status`,`period_end`);--> statement-breakpoint
CREATE INDEX `idx_billing_account_plan` ON `billing_accounts` (`plan_version_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_credit_idempotency` ON `billing_credit_entries` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_billing_credit_org_created` ON `billing_credit_entries` (`organization_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_billing_credit_expiry` ON `billing_credit_entries` (`organization_id`,`expires_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_plan_key_version` ON `billing_plan_versions` (`plan_key`,`version`);--> statement-breakpoint
CREATE INDEX `idx_billing_plan_active` ON `billing_plan_versions` (`plan_key`,`status`,`effective_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_charge_gateway_log` ON `billing_usage_charges` (`gateway_log_id`) WHERE "billing_usage_charges"."gateway_log_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_charge_provider_usage` ON `billing_usage_charges` (`provider_usage_id`) WHERE "billing_usage_charges"."provider_usage_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `idx_billing_charge_org_occurred` ON `billing_usage_charges` (`organization_id`,`occurred_at`);--> statement-breakpoint
CREATE INDEX `idx_billing_charge_reservation` ON `billing_usage_charges` (`reservation_id`);--> statement-breakpoint
CREATE INDEX `idx_billing_charge_metering` ON `billing_usage_charges` (`metering_ready`,`usage_quality`,`occurred_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_usage_period` ON `billing_usage_periods` (`organization_id`,`period_start`,`period_end`);--> statement-breakpoint
CREATE INDEX `idx_billing_usage_period_end` ON `billing_usage_periods` (`period_end`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_billing_reservation_idempotency` ON `billing_usage_reservations` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `idx_billing_reservation_org_status` ON `billing_usage_reservations` (`organization_id`,`status`,`expires_at`);--> statement-breakpoint
CREATE INDEX `idx_billing_reservation_tedi_created` ON `billing_usage_reservations` (`tedi_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `idx_billing_reservation_trace` ON `billing_usage_reservations` (`trace_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_stripe_meter_outbox_idempotency` ON `stripe_meter_outbox` (`idempotency_key`);--> statement-breakpoint
CREATE UNIQUE INDEX `uniq_stripe_meter_outbox_charge` ON `stripe_meter_outbox` (`usage_charge_id`);--> statement-breakpoint
CREATE INDEX `idx_stripe_meter_outbox_retry` ON `stripe_meter_outbox` (`status`,`next_attempt_at`,`lease_expires_at`);
--> statement-breakpoint
INSERT INTO billing_plan_versions (
	id, plan_key, version, status, name, currency,
	monthly_price_micros, annual_price_micros,
	included_monthly_tokens, included_monthly_credit_micros,
	overage_unit_tokens, overage_unit_price_micros,
	max_tedis, max_cron_jobs_per_tedi, max_iterations_per_task,
	default_daily_token_limit, default_daily_message_limit, allow_overage,
	stripe_product_id, stripe_monthly_price_id, stripe_annual_price_id,
	stripe_overage_price_id, metadata, effective_at
) VALUES
	(
		'starter-v1', 'starter', 1, 'active', 'Starter', 'usd',
		0, 0, 100000, 0, 1000, 0,
		1, 2, 8, 100000, 100, 0,
		NULL, NULL, NULL, NULL,
		'{"trialDays":14}', '2026-07-27T00:00:00.000Z'
	),
	(
		'growth-v1', 'growth', 1, 'active', 'Growth', 'usd',
		249000000, 2399000000, 500000, 0, 1000, 50000,
		1, 10, 16, 250000, 200, 1,
		NULL, NULL,
		NULL,
		NULL,
		'{"stripeTransformQuantity":{"divideBy":1000,"round":"up"}}',
		'2026-07-27T00:00:00.000Z'
	),
	(
		'business-v1', 'business', 1, 'active', 'Business', 'usd',
		499000000, 4799000000, 2000000, 0, 1000, 50000,
		3, 25, 32, 1000000, 500, 1,
		NULL, NULL,
		NULL,
		NULL,
		'{"stripeTransformQuantity":{"divideBy":1000,"round":"up"}}',
		'2026-07-27T00:00:00.000Z'
	),
	(
		'enterprise-v1', 'enterprise', 1, 'active', 'Enterprise', 'usd',
		999000000, 9599000000, -1, 0, 1000, 0,
		-1, -1, 64, -1, -1, 1,
		NULL, NULL,
		NULL, NULL,
		'{"unlimitedTokens":true}', '2026-07-27T00:00:00.000Z'
	);
--> statement-breakpoint
INSERT INTO billing_accounts (
	organization_id, plan_version_id, status, billing_mode,
	period_start, period_end, hard_spend_limit_micros,
	credit_balance_micros, entitlement_version, metadata,
	created_at, updated_at
)
SELECT
	org.id,
	COALESCE(org.subscription_tier, 'starter') || '-v1',
	CASE
		WHEN org.subscription_status = 'trial'
			AND org.trial_ends_at IS NOT NULL
			AND datetime(org.trial_ends_at) <= datetime('now')
			THEN 'suspended'
		WHEN org.subscription_status IN ('trial', 'active', 'cancelled', 'suspended')
			THEN org.subscription_status
		ELSE 'suspended'
	END,
	CASE
		WHEN org.stripe_customer_id IS NOT NULL THEN 'stripe'
		WHEN org.subscription_status = 'active' THEN 'invoice'
		ELSE 'trial'
	END,
	CASE
		WHEN org.subscription_status = 'trial'
			THEN COALESCE(org.created_at, datetime('now', 'start of month'))
		ELSE datetime('now', 'start of month')
	END,
	CASE
		WHEN org.subscription_status = 'trial'
			THEN COALESCE(org.trial_ends_at, datetime('now'))
		ELSE datetime('now', 'start of month', '+1 month')
	END,
	NULL, 0, 1,
	json_object('migratedFromOrganizations', 1),
	CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM organizations AS org
WHERE COALESCE(org.subscription_tier, 'starter')
	IN ('starter', 'growth', 'business', 'enterprise');
--> statement-breakpoint
CREATE TRIGGER billing_credit_entries_nonzero
BEFORE INSERT ON billing_credit_entries
WHEN NEW.amount_micros = 0
BEGIN
	SELECT RAISE(ABORT, 'billing credit entry must be non-zero');
END;
--> statement-breakpoint
CREATE TRIGGER billing_credit_entries_positive_kind
BEFORE INSERT ON billing_credit_entries
WHEN NEW.kind IN ('grant', 'refund') AND NEW.amount_micros < 0
BEGIN
	SELECT RAISE(ABORT, 'billing grant/refund must be positive');
END;
--> statement-breakpoint
CREATE TRIGGER billing_credit_entries_debit_kind
BEFORE INSERT ON billing_credit_entries
WHEN NEW.kind = 'debit' AND NEW.amount_micros > 0
BEGIN
	SELECT RAISE(ABORT, 'billing debit must be negative');
END;
--> statement-breakpoint
CREATE TRIGGER billing_credit_entries_sufficient_balance
BEFORE INSERT ON billing_credit_entries
WHEN (
	SELECT credit_balance_micros + NEW.amount_micros
	FROM billing_accounts
	WHERE organization_id = NEW.organization_id
) < 0
BEGIN
	SELECT RAISE(ABORT, 'insufficient billing credit');
END;
--> statement-breakpoint
CREATE TRIGGER billing_credit_entries_apply_insert
AFTER INSERT ON billing_credit_entries
BEGIN
	UPDATE billing_accounts
	SET
		credit_balance_micros = credit_balance_micros + NEW.amount_micros,
		updated_at = CURRENT_TIMESTAMP
	WHERE organization_id = NEW.organization_id;
END;
--> statement-breakpoint
CREATE TRIGGER billing_credit_entries_immutable_update
BEFORE UPDATE ON billing_credit_entries
BEGIN
	SELECT RAISE(ABORT, 'billing credit journal is immutable');
END;
--> statement-breakpoint
CREATE TRIGGER billing_credit_entries_immutable_delete
BEFORE DELETE ON billing_credit_entries
BEGIN
	SELECT RAISE(ABORT, 'billing credit journal is immutable');
END;
