/**
 * Canonical Tedix billing, entitlement, credit, and metered-usage schema.
 *
 * D1 is the financial control-plane source of truth. Provider ledgers and
 * Stripe are projections: provider rows settle reservations, while a durable
 * outbox exports customer overage without making either vendor authoritative.
 *
 * Monetary values are integer USD micros (1 USD = 1_000_000 micros). Tokens
 * remain integer usage units. Never combine provider cost and customer charge.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { organizations } from "./organizations";
import { tedis } from "./tedis";

export const BILLING_PLAN_KEYS = [
	"starter",
	"growth",
	"business",
	"enterprise",
] as const;
export type BillingPlanKey = (typeof BILLING_PLAN_KEYS)[number];

export const BILLING_PLAN_STATUSES = ["draft", "active", "retired"] as const;
export type BillingPlanStatus = (typeof BILLING_PLAN_STATUSES)[number];

export const billingPlanVersions = sqliteTable(
	"billing_plan_versions",
	{
		id: text("id").primaryKey(),
		planKey: text("plan_key", { enum: BILLING_PLAN_KEYS }).notNull(),
		version: integer("version").notNull(),
		status: text("status", { enum: BILLING_PLAN_STATUSES })
			.notNull()
			.default("draft"),
		name: text("name").notNull(),
		currency: text("currency").notNull().default("usd"),
		monthlyPriceMicros: integer("monthly_price_micros").notNull().default(0),
		annualPriceMicros: integer("annual_price_micros").notNull().default(0),
		includedMonthlyTokens: integer("included_monthly_tokens").notNull(),
		includedMonthlyCreditMicros: integer("included_monthly_credit_micros")
			.notNull()
			.default(0),
		/** Customer overage unit, distinct from provider model cost. */
		overageUnitTokens: integer("overage_unit_tokens").notNull().default(1_000),
		overageUnitPriceMicros: integer("overage_unit_price_micros")
			.notNull()
			.default(0),
		maxTedis: integer("max_tedis").notNull(),
		maxCronJobsPerTedi: integer("max_cron_jobs_per_tedi").notNull(),
		maxIterationsPerTask: integer("max_iterations_per_task").notNull(),
		defaultDailyTokenLimit: integer("default_daily_token_limit").notNull(),
		defaultDailyMessageLimit: integer("default_daily_message_limit").notNull(),
		allowOverage: integer("allow_overage", { mode: "boolean" })
			.notNull()
			.default(false),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		effectiveAt: text("effective_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_plan_key_version").on(
			table.planKey,
			table.version,
		),
		index("idx_billing_plan_active").on(
			table.planKey,
			table.status,
			table.effectiveAt,
		),
	],
);

export const BILLING_ACCOUNT_STATUSES = [
	"trial",
	"active",
	"past_due",
	"cancelled",
	"suspended",
] as const;
export type BillingAccountStatus = (typeof BILLING_ACCOUNT_STATUSES)[number];

export const BILLING_MODES = [
	"trial",
	"stripe",
	"invoice",
	"internal",
] as const;
export type BillingMode = (typeof BILLING_MODES)[number];

/** Effective entitlement pinned to a plan version for one organization. */
export const billingAccounts = sqliteTable(
	"billing_accounts",
	{
		organizationId: text("organization_id")
			.primaryKey()
			.references(() => organizations.id, { onDelete: "cascade" }),
		planVersionId: text("plan_version_id")
			.notNull()
			.references(() => billingPlanVersions.id),
		status: text("status", { enum: BILLING_ACCOUNT_STATUSES })
			.notNull()
			.default("trial"),
		billingMode: text("billing_mode", { enum: BILLING_MODES })
			.notNull()
			.default("trial"),
		stripeEnvironment: text("stripe_environment", {
			enum: ["test", "live"],
		}),
		stripeCustomerId: text("stripe_customer_id"),
		stripeSubscriptionId: text("stripe_subscription_id"),
		stripeCancelAtPeriodEnd: integer("stripe_cancel_at_period_end", {
			mode: "boolean",
		}),
		periodStart: text("period_start").notNull(),
		periodEnd: text("period_end").notNull(),
		hardSpendLimitMicros: integer("hard_spend_limit_micros"),
		/**
		 * Materialized balance backed by billing_credit_entries. Migration-owned
		 * triggers update it in the journal insert transaction.
		 */
		creditBalanceMicros: integer("credit_balance_micros").notNull().default(0),
		graceEndsAt: text("grace_ends_at"),
		entitlementVersion: integer("entitlement_version").notNull().default(1),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_billing_account_status").on(table.status, table.periodEnd),
		index("idx_billing_account_stripe_environment").on(table.stripeEnvironment),
		uniqueIndex("uniq_billing_account_stripe_customer")
			.on(table.stripeEnvironment, table.stripeCustomerId)
			.where(sql`${table.stripeCustomerId} IS NOT NULL`),
		uniqueIndex("uniq_billing_account_stripe_subscription")
			.on(table.stripeEnvironment, table.stripeSubscriptionId)
			.where(sql`${table.stripeSubscriptionId} IS NOT NULL`),
		index("idx_billing_account_plan").on(table.planVersionId),
	],
);

export const BILLING_CREDIT_ENTRY_KINDS = [
	"grant",
	"debit",
	"refund",
	"adjustment",
] as const;
export type BillingCreditEntryKind =
	(typeof BILLING_CREDIT_ENTRY_KINDS)[number];

/**
 * Immutable monetary-credit journal. Positive entries add balance; negative
 * entries consume it. Expired positive grants stop contributing to balance.
 */
export const billingCreditEntries = sqliteTable(
	"billing_credit_entries",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: BILLING_CREDIT_ENTRY_KINDS }).notNull(),
		amountMicros: integer("amount_micros").notNull(),
		sourceType: text("source_type").notNull(),
		sourceRef: text("source_ref"),
		usageChargeId: text("usage_charge_id"),
		idempotencyKey: text("idempotency_key").notNull(),
		expiresAt: text("expires_at"),
		description: text("description"),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_credit_idempotency").on(table.idempotencyKey),
		index("idx_billing_credit_org_created").on(
			table.organizationId,
			table.createdAt,
		),
		index("idx_billing_credit_expiry").on(
			table.organizationId,
			table.expiresAt,
		),
	],
);

export const BILLING_INFERENCE_POLICY_SCOPES = [
	"organization",
	"tedi",
] as const;
export type BillingInferencePolicyScope =
	(typeof BILLING_INFERENCE_POLICY_SCOPES)[number];

/**
 * Explicit inference-admission policy. Plan defaults are materialized into the
 * organization row; an optional tedi row can only narrow that boundary.
 */
export const billingInferencePolicies = sqliteTable(
	"billing_inference_policies",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		scope: text("scope", { enum: BILLING_INFERENCE_POLICY_SCOPES }).notNull(),
		/** Stable uniqueness key: `organization` or the tedi UUID. */
		subjectKey: text("subject_key").notNull(),
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "cascade",
		}),
		allowedModelTiers: text("allowed_model_tiers", { mode: "json" }).$type<
			Array<"economy" | "balanced" | "frontier">
		>(),
		dailyTokenLimit: integer("daily_token_limit"),
		dailySpendLimitMicros: integer("daily_spend_limit_micros"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_inference_policy_subject").on(
			table.organizationId,
			table.scope,
			table.subjectKey,
		),
		index("idx_billing_inference_policy_tedi").on(table.tediId),
		check(
			"chk_billing_inference_policy_subject",
			sql`(${table.scope} = 'organization' AND ${table.subjectKey} = 'organization' AND ${table.tediId} IS NULL) OR (${table.scope} = 'tedi' AND ${table.subjectKey} = ${table.tediId} AND ${table.tediId} IS NOT NULL)`,
		),
		check(
			"chk_billing_inference_policy_limits",
			sql`(${table.dailyTokenLimit} IS NULL OR ${table.dailyTokenLimit} >= 0) AND (${table.dailySpendLimitMicros} IS NULL OR ${table.dailySpendLimitMicros} >= 0)`,
		),
	],
);

export const INFERENCE_CAPACITY_PACK_STATUSES = [
	"draft",
	"active",
	"retired",
] as const;
export type InferenceCapacityPackStatus =
	(typeof INFERENCE_CAPACITY_PACK_STATUSES)[number];

/** Immutable commercial version of one daily top-up. */
export const billingInferenceCapacityPackVersions = sqliteTable(
	"billing_inference_capacity_pack_versions",
	{
		id: text("id").primaryKey(),
		packKey: text("pack_key").notNull(),
		version: integer("version").notNull(),
		status: text("status", { enum: INFERENCE_CAPACITY_PACK_STATUSES })
			.notNull()
			.default("draft"),
		name: text("name").notNull(),
		currency: text("currency").notNull().default("usd"),
		priceMicros: integer("price_micros").notNull(),
		tokenAmount: integer("token_amount").notNull(),
		spendAmountMicros: integer("spend_amount_micros").notNull(),
		stripeEnvironment: text("stripe_environment", {
			enum: ["test", "live"],
		}).notNull(),
		stripeLookupKey: text("stripe_lookup_key").notNull(),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		effectiveAt: text("effective_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_inference_capacity_pack_version").on(
			table.packKey,
			table.version,
			table.stripeEnvironment,
		),
		uniqueIndex("uniq_inference_capacity_pack_lookup").on(
			table.stripeEnvironment,
			table.stripeLookupKey,
		),
		index("idx_inference_capacity_pack_active").on(
			table.stripeEnvironment,
			table.status,
			table.effectiveAt,
		),
		check(
			"chk_inference_capacity_pack_positive",
			sql`${table.priceMicros} > 0 AND ${table.tokenAmount} > 0 AND ${table.spendAmountMicros} > 0`,
		),
	],
);

/**
 * Append-only capacity purchased for one UTC AI Gateway budget day.
 * Reservations remain the consumption ledger; these rows only enlarge that
 * day's organization-level admission ceiling until their explicit expiry.
 */
export const billingCapacityAllocations = sqliteTable(
	"billing_capacity_allocations",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		packVersionId: text("pack_version_id").references(
			() => billingInferenceCapacityPackVersions.id,
		),
		budgetDay: text("budget_day").notNull(),
		tokenAmount: integer("token_amount").notNull().default(0),
		spendAmountMicros: integer("spend_amount_micros").notNull().default(0),
		sourceType: text("source_type").notNull(),
		sourceRef: text("source_ref"),
		idempotencyKey: text("idempotency_key").notNull(),
		stripeEnvironment: text("stripe_environment", {
			enum: ["test", "live"],
		}).notNull(),
		expiresAt: text("expires_at").notNull(),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_capacity_allocation_idempotency").on(
			table.idempotencyKey,
		),
		index("idx_billing_capacity_allocation_active").on(
			table.organizationId,
			table.stripeEnvironment,
			table.budgetDay,
			table.expiresAt,
		),
		check(
			"chk_billing_capacity_allocation_direction",
			sql`(${table.tokenAmount} > 0 OR ${table.spendAmountMicros} > 0) OR (${table.tokenAmount} < 0 OR ${table.spendAmountMicros} < 0)`,
		),
		check(
			"chk_billing_capacity_allocation_same_direction",
			sql`(${table.tokenAmount} >= 0 AND ${table.spendAmountMicros} >= 0) OR (${table.tokenAmount} <= 0 AND ${table.spendAmountMicros} <= 0)`,
		),
	],
);

export const BILLING_RESERVATION_STATUSES = [
	"reserved",
	"settled",
	"released",
	"rejected",
	"expired",
] as const;
export type BillingReservationStatus =
	(typeof BILLING_RESERVATION_STATUSES)[number];

export const BILLING_USAGE_SOURCES = [
	"operator",
	"automation",
	"observer",
	"compaction",
	"kernel",
	"evaluation",
	"system",
	"gadget",
] as const;
export type BillingUsageSource = (typeof BILLING_USAGE_SOURCES)[number];

/** Pre-inference admission reservation. */
export const billingUsageReservations = sqliteTable(
	"billing_usage_reservations",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		planVersionId: text("plan_version_id")
			.notNull()
			.references(() => billingPlanVersions.id),
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "set null",
		}),
		status: text("status", { enum: BILLING_RESERVATION_STATUSES })
			.notNull()
			.default("reserved"),
		source: text("source", { enum: BILLING_USAGE_SOURCES }).notNull(),
		provider: text("provider").notNull(),
		model: text("model").notNull(),
		estimatedInputTokens: integer("estimated_input_tokens")
			.notNull()
			.default(0),
		estimatedOutputTokens: integer("estimated_output_tokens")
			.notNull()
			.default(0),
		estimatedChargeMicros: integer("estimated_charge_micros")
			.notNull()
			.default(0),
		periodStart: text("period_start").notNull(),
		periodEnd: text("period_end").notNull(),
		runId: text("run_id"),
		traceId: text("trace_id"),
		idempotencyKey: text("idempotency_key").notNull(),
		rejectionCode: text("rejection_code"),
		expiresAt: text("expires_at").notNull(),
		settledAt: text("settled_at"),
		releasedAt: text("released_at"),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_reservation_idempotency").on(
			table.idempotencyKey,
		),
		index("idx_billing_reservation_org_status").on(
			table.organizationId,
			table.status,
			table.expiresAt,
		),
		index("idx_billing_reservation_plan").on(table.planVersionId),
		index("idx_billing_reservation_tedi_created").on(
			table.tediId,
			table.createdAt,
		),
		index("idx_billing_reservation_trace").on(table.traceId),
	],
);

/**
 * One usage period per org. Included and overage tokens are updated when a
 * provider usage row settles, not when a request is merely reserved.
 */
export const billingUsagePeriods = sqliteTable(
	"billing_usage_periods",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		planVersionId: text("plan_version_id")
			.notNull()
			.references(() => billingPlanVersions.id),
		periodStart: text("period_start").notNull(),
		periodEnd: text("period_end").notNull(),
		includedTokens: integer("included_tokens").notNull(),
		usedInputTokens: integer("used_input_tokens").notNull().default(0),
		usedOutputTokens: integer("used_output_tokens").notNull().default(0),
		meteredOverageTokens: integer("metered_overage_tokens")
			.notNull()
			.default(0),
		providerCostMicros: integer("provider_cost_micros").notNull().default(0),
		customerChargeMicros: integer("customer_charge_micros")
			.notNull()
			.default(0),
		creditAppliedMicros: integer("credit_applied_micros").notNull().default(0),
		/**
		 * Optimistic settlement fence. D1 batches are atomic, while this version
		 * prevents a pre-read calculation from applying after another settlement
		 * has already advanced the period.
		 */
		settlementVersion: integer("settlement_version").notNull().default(0),
		/** Unique marker paired with settlementVersion inside one D1 batch. */
		lastSettlementId: text("last_settlement_id"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_usage_period").on(
			table.organizationId,
			table.periodStart,
			table.periodEnd,
		),
		index("idx_billing_usage_period_end").on(table.periodEnd),
	],
);

export const BILLING_USAGE_QUALITIES = [
	"estimated",
	"gateway_reported",
	"provider_reported",
] as const;
export type BillingUsageQuality = (typeof BILLING_USAGE_QUALITIES)[number];

export const BILLING_PROVIDER_COST_QUALITIES = [
	"estimated",
	"gateway_reported",
	"provider_reported",
	"provider_reconciled",
] as const;
export type BillingProviderCostQuality =
	(typeof BILLING_PROVIDER_COST_QUALITIES)[number];

/** Settled provider usage and its distinct customer billable result. */
export const billingUsageCharges = sqliteTable(
	"billing_usage_charges",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "set null",
		}),
		reservationId: text("reservation_id").references(
			() => billingUsageReservations.id,
			{ onDelete: "set null" },
		),
		usagePeriodId: text("usage_period_id")
			.notNull()
			.references(() => billingUsagePeriods.id, { onDelete: "cascade" }),
		gatewayLogId: text("gateway_log_id"),
		providerUsageId: text("provider_usage_id"),
		provider: text("provider").notNull(),
		model: text("model").notNull(),
		source: text("source", { enum: BILLING_USAGE_SOURCES }).notNull(),
		inputTokens: integer("input_tokens").notNull().default(0),
		outputTokens: integer("output_tokens").notNull().default(0),
		includedTokensApplied: integer("included_tokens_applied")
			.notNull()
			.default(0),
		meteredOverageTokens: integer("metered_overage_tokens")
			.notNull()
			.default(0),
		providerCostMicros: integer("provider_cost_micros").notNull().default(0),
		customerChargeMicros: integer("customer_charge_micros")
			.notNull()
			.default(0),
		creditAppliedMicros: integer("credit_applied_micros").notNull().default(0),
		usageQuality: text("usage_quality", { enum: BILLING_USAGE_QUALITIES })
			.notNull()
			.default("gateway_reported"),
		providerCostQuality: text("provider_cost_quality", {
			enum: BILLING_PROVIDER_COST_QUALITIES,
		})
			.notNull()
			.default("estimated"),
		meteringReady: integer("metering_ready", { mode: "boolean" })
			.notNull()
			.default(false),
		providerReconciledAt: text("provider_reconciled_at"),
		rateCardVersion: text("rate_card_version"),
		occurredAt: text("occurred_at").notNull(),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_charge_gateway_log")
			.on(table.gatewayLogId)
			.where(sql`${table.gatewayLogId} IS NOT NULL`),
		uniqueIndex("uniq_billing_charge_provider_usage")
			.on(table.providerUsageId)
			.where(sql`${table.providerUsageId} IS NOT NULL`),
		index("idx_billing_charge_org_occurred").on(
			table.organizationId,
			table.occurredAt,
		),
		index("idx_billing_charge_reservation").on(table.reservationId),
		index("idx_billing_charge_metering").on(
			table.meteringReady,
			table.usageQuality,
			table.occurredAt,
		),
	],
);

export const BILLING_USAGE_QUARANTINE_REASONS = [
	"missing_reservation",
	"missing_billing_account",
	"missing_plan_version",
	"invalid_attribution",
	"unpriced_usage",
] as const;
export type BillingUsageQuarantineReason =
	(typeof BILLING_USAGE_QUARANTINE_REASONS)[number];

/**
 * Permanent classification for provider rows that cannot safely become a
 * customer charge. The source ledger remains intact; this table prevents a
 * poison row from retrying forever or starving current reserved usage.
 */
export const billingUsageQuarantines = sqliteTable(
	"billing_usage_quarantines",
	{
		id: text("id").primaryKey(),
		gatewayLogId: text("gateway_log_id").notNull(),
		organizationId: text("organization_id"),
		reason: text("reason", {
			enum: BILLING_USAGE_QUARANTINE_REASONS,
		}).notNull(),
		sourceSnapshotAt: text("source_snapshot_at").notNull(),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_usage_quarantine_gateway_log").on(
			table.gatewayLogId,
		),
		index("idx_billing_usage_quarantine_reason_created").on(
			table.reason,
			table.createdAt,
		),
	],
);

export const BILLING_PROVIDER_USAGE_KINDS = [
	"voice_stt",
	"voice_tts",
	"image_generation",
	"seo_data",
	"workstation_compute",
	"other",
] as const;
export type BillingProviderUsageKind =
	(typeof BILLING_PROVIDER_USAGE_KINDS)[number];

export const BILLING_PROVIDER_USAGE_UNITS = [
	"seconds",
	"characters",
	"images",
	"compute_seconds",
	"units",
] as const;
export type BillingProviderUsageUnit =
	(typeof BILLING_PROVIDER_USAGE_UNITS)[number];

/**
 * Non-token provider usage observation. It is deliberately separate from
 * customer charges: a row is cost/reconciliation evidence, never permission to
 * meter an unpriced provider-specific unit to a customer.
 */
export const billingProviderUsage = sqliteTable(
	"billing_provider_usage",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id"),
		tediId: text("tedi_id"),
		reservationId: text("reservation_id"),
		gatewayLogId: text("gateway_log_id"),
		providerUsageId: text("provider_usage_id"),
		provider: text("provider").notNull(),
		model: text("model").notNull(),
		usageKind: text("usage_kind", {
			enum: BILLING_PROVIDER_USAGE_KINDS,
		}).notNull(),
		unit: text("unit", { enum: BILLING_PROVIDER_USAGE_UNITS }).notNull(),
		quantity: integer("quantity").notNull(),
		providerCostMicros: integer("provider_cost_micros").notNull().default(0),
		providerCostQuality: text("provider_cost_quality", {
			enum: BILLING_PROVIDER_COST_QUALITIES,
		})
			.notNull()
			.default("estimated"),
		customerMeteringReady: integer("customer_metering_ready", {
			mode: "boolean",
		})
			.notNull()
			.default(false),
		occurredAt: text("occurred_at").notNull(),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_provider_usage_gateway_log")
			.on(table.gatewayLogId)
			.where(sql`${table.gatewayLogId} IS NOT NULL`),
		uniqueIndex("uniq_billing_provider_usage_provider_id")
			.on(table.providerUsageId)
			.where(sql`${table.providerUsageId} IS NOT NULL`),
		index("idx_billing_provider_usage_org_occurred").on(
			table.organizationId,
			table.occurredAt,
		),
		index("idx_billing_provider_usage_kind_occurred").on(
			table.usageKind,
			table.occurredAt,
		),
	],
);

export const BILLING_SERVICE_KEYS = ["seo"] as const;
export type BillingServiceKey = (typeof BILLING_SERVICE_KEYS)[number];

export const BILLING_SERVICE_OPERATION_KEYS = [
	"research_keywords",
	"get_serp_results",
	"get_domain_overview",
	"get_backlinks_overview",
] as const;
export type BillingServiceOperationKey =
	(typeof BILLING_SERVICE_OPERATION_KEYS)[number];

export const BILLING_SERVICE_RATE_CARD_STATUSES = [
	"draft",
	"active",
	"retired",
] as const;
export type BillingServiceRateCardStatus =
	(typeof BILLING_SERVICE_RATE_CARD_STATUSES)[number];

/**
 * Immutable customer-facing prices for non-token provider operations.
 *
 * One credit is a stable Tedix product unit. It is deliberately not derived
 * from provider cost: the provider can change without silently repricing an
 * already admitted tenant operation.
 */
export const billingServiceRateCards = sqliteTable(
	"billing_service_rate_cards",
	{
		id: text("id").primaryKey(),
		serviceKey: text("service_key", { enum: BILLING_SERVICE_KEYS }).notNull(),
		operationKey: text("operation_key", {
			enum: BILLING_SERVICE_OPERATION_KEYS,
		}).notNull(),
		version: integer("version").notNull(),
		status: text("status", {
			enum: BILLING_SERVICE_RATE_CARD_STATUSES,
		})
			.notNull()
			.default("draft"),
		provider: text("provider").notNull(),
		providerEndpoint: text("provider_endpoint").notNull(),
		creditCost: integer("credit_cost").notNull(),
		/** Display/accounting value of one consumed credit in USD micros. */
		customerValueMicros: integer("customer_value_micros").notNull(),
		/** Admission ceiling used to bound provider spend before the call. */
		providerCostCeilingMicros: integer(
			"provider_cost_ceiling_micros",
		).notNull(),
		effectiveAt: text("effective_at").notNull(),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_service_rate_card_version").on(
			table.serviceKey,
			table.operationKey,
			table.version,
		),
		index("idx_billing_service_rate_card_active").on(
			table.serviceKey,
			table.operationKey,
			table.status,
			table.effectiveAt,
		),
	],
);

/** Included service credits attached to an immutable billing plan version. */
export const billingPlanServiceAllowances = sqliteTable(
	"billing_plan_service_allowances",
	{
		id: text("id").primaryKey(),
		planVersionId: text("plan_version_id")
			.notNull()
			.references(() => billingPlanVersions.id),
		serviceKey: text("service_key", { enum: BILLING_SERVICE_KEYS }).notNull(),
		includedCredits: integer("included_credits").notNull(),
		perTediMonthlyLimit: integer("per_tedi_monthly_limit"),
		monthlyProviderCostLimitMicros: integer(
			"monthly_provider_cost_limit_micros",
		),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_plan_service_allowance").on(
			table.planVersionId,
			table.serviceKey,
		),
	],
);

/**
 * Optional tenant-owned lower ceilings and kill switch. Null means inherit the
 * plan allowance. A control can reduce access but never mint credits.
 */
export const billingServiceCreditControls = sqliteTable(
	"billing_service_credit_controls",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		serviceKey: text("service_key", { enum: BILLING_SERVICE_KEYS }).notNull(),
		enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
		monthlyCreditLimit: integer("monthly_credit_limit"),
		perTediMonthlyLimit: integer("per_tedi_monthly_limit"),
		monthlyProviderCostLimitMicros: integer(
			"monthly_provider_cost_limit_micros",
		),
		updatedBy: text("updated_by"),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_service_credit_control").on(
			table.organizationId,
			table.serviceKey,
		),
	],
);

export const BILLING_SERVICE_CREDIT_ENTRY_KINDS = [
	"grant",
	"debit",
	"refund",
	"adjustment",
] as const;
export type BillingServiceCreditEntryKind =
	(typeof BILLING_SERVICE_CREDIT_ENTRY_KINDS)[number];

/** Immutable integer service-credit journal. */
export const billingServiceCreditEntries = sqliteTable(
	"billing_service_credit_entries",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		serviceKey: text("service_key", { enum: BILLING_SERVICE_KEYS }).notNull(),
		kind: text("kind", {
			enum: BILLING_SERVICE_CREDIT_ENTRY_KINDS,
		}).notNull(),
		amountCredits: integer("amount_credits").notNull(),
		sourceType: text("source_type").notNull(),
		sourceRef: text("source_ref"),
		reservationId: text("reservation_id"),
		idempotencyKey: text("idempotency_key").notNull(),
		expiresAt: text("expires_at"),
		description: text("description"),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_service_credit_idempotency").on(
			table.idempotencyKey,
		),
		index("idx_billing_service_credit_org_service_created").on(
			table.organizationId,
			table.serviceKey,
			table.createdAt,
		),
		index("idx_billing_service_credit_expiry").on(
			table.organizationId,
			table.serviceKey,
			table.expiresAt,
		),
	],
);

export const BILLING_SERVICE_CREDIT_RESERVATION_STATUSES = [
	"reserved",
	"settled",
	"released",
	"expired",
	"rejected",
] as const;
export type BillingServiceCreditReservationStatus =
	(typeof BILLING_SERVICE_CREDIT_RESERVATION_STATUSES)[number];

/** Atomic pre-provider reservation pinned to plan and rate-card versions. */
export const billingServiceCreditReservations = sqliteTable(
	"billing_service_credit_reservations",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		planVersionId: text("plan_version_id")
			.notNull()
			.references(() => billingPlanVersions.id),
		rateCardId: text("rate_card_id")
			.notNull()
			.references(() => billingServiceRateCards.id),
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "set null",
		}),
		serviceKey: text("service_key", { enum: BILLING_SERVICE_KEYS }).notNull(),
		operationKey: text("operation_key", {
			enum: BILLING_SERVICE_OPERATION_KEYS,
		}).notNull(),
		status: text("status", {
			enum: BILLING_SERVICE_CREDIT_RESERVATION_STATUSES,
		})
			.notNull()
			.default("reserved"),
		creditsReserved: integer("credits_reserved").notNull(),
		customerValueMicros: integer("customer_value_micros").notNull(),
		providerCostCeilingMicros: integer(
			"provider_cost_ceiling_micros",
		).notNull(),
		actualProviderCostMicros: integer("actual_provider_cost_micros"),
		providerUsageId: text("provider_usage_id"),
		periodStart: text("period_start").notNull(),
		periodEnd: text("period_end").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		rejectionCode: text("rejection_code"),
		expiresAt: text("expires_at").notNull(),
		settledAt: text("settled_at"),
		releasedAt: text("released_at"),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_service_reservation_idempotency").on(
			table.idempotencyKey,
		),
		uniqueIndex("uniq_billing_service_reservation_provider_usage")
			.on(table.providerUsageId)
			.where(sql`${table.providerUsageId} IS NOT NULL`),
		index("idx_billing_service_reservation_org_status").on(
			table.organizationId,
			table.serviceKey,
			table.status,
			table.expiresAt,
		),
		index("idx_billing_service_reservation_tedi_period").on(
			table.tediId,
			table.serviceKey,
			table.periodStart,
		),
	],
);

export const STRIPE_METER_OUTBOX_STATUSES = [
	"pending",
	"sending",
	"sent",
	"failed",
	// Terminal dead-letter: the attempt ceiling was exhausted. Never re-claimed;
	// requires operator intervention (fix the Stripe entity, reset to pending).
	"dead",
] as const;
export type StripeMeterOutboxStatus =
	(typeof STRIPE_METER_OUTBOX_STATUSES)[number];

/** Durable, idempotent projection of settled overage to Stripe. */
export const stripeMeterOutbox = sqliteTable(
	"stripe_meter_outbox",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		usageChargeId: text("usage_charge_id")
			.notNull()
			.references(() => billingUsageCharges.id, { onDelete: "cascade" }),
		stripeCustomerId: text("stripe_customer_id").notNull(),
		stripeEnvironment: text("stripe_environment", {
			enum: ["test", "live"],
		})
			.notNull()
			.default("live"),
		eventName: text("event_name").notNull(),
		quantity: integer("quantity").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		status: text("status", { enum: STRIPE_METER_OUTBOX_STATUSES })
			.notNull()
			.default("pending"),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: text("next_attempt_at").notNull(),
		leaseExpiresAt: text("lease_expires_at"),
		stripeEventId: text("stripe_event_id"),
		lastError: text("last_error"),
		sentAt: text("sent_at"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_stripe_meter_outbox_idempotency").on(
			table.idempotencyKey,
		),
		uniqueIndex("uniq_stripe_meter_outbox_charge").on(table.usageChargeId),
		index("idx_stripe_meter_outbox_retry").on(
			table.stripeEnvironment,
			table.status,
			table.nextAttemptAt,
			table.leaseExpiresAt,
		),
	],
);

export const STRIPE_WEBHOOK_EVENT_STATUSES = [
	"processing",
	"processed",
	"failed",
] as const;
export type StripeWebhookEventStatus =
	(typeof STRIPE_WEBHOOK_EVENT_STATUSES)[number];

/**
 * Durable Stripe delivery receipt and lease. Stripe may deliver duplicates and
 * does not guarantee event order, so handlers claim an event ID before side
 * effects and retain the canonical subscription entity key for stale checks.
 */
export const stripeWebhookEvents = sqliteTable(
	"stripe_webhook_events",
	{
		eventId: text("event_id").primaryKey(),
		eventType: text("event_type").notNull(),
		entityKey: text("entity_key").notNull(),
		eventCreatedAt: integer("event_created_at").notNull(),
		status: text("status", { enum: STRIPE_WEBHOOK_EVENT_STATUSES })
			.notNull()
			.default("processing"),
		attemptCount: integer("attempt_count").notNull().default(1),
		leaseExpiresAt: text("lease_expires_at"),
		outcome: text("outcome"),
		lastError: text("last_error"),
		processedAt: text("processed_at"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		index("idx_stripe_webhook_entity_created").on(
			table.entityKey,
			table.eventCreatedAt,
		),
		index("idx_stripe_webhook_status_lease").on(
			table.status,
			table.leaseExpiresAt,
		),
	],
);

export const BILLING_RECONCILIATION_STATUSES = [
	"pending",
	"matched",
	"variance",
	"approved",
] as const;
export type BillingReconciliationStatus =
	(typeof BILLING_RECONCILIATION_STATUSES)[number];

/**
 * Provider-authoritative period reconciliation. This is deliberately separate
 * from customer metering: Azure invoice cost can be pending while Gateway
 * token usage is already safe to meter.
 */
export const billingProviderReconciliations = sqliteTable(
	"billing_provider_reconciliations",
	{
		id: text("id").primaryKey(),
		provider: text("provider").notNull(),
		providerResource: text("provider_resource").notNull().default(""),
		periodStart: text("period_start").notNull(),
		periodEnd: text("period_end").notNull(),
		ledgerCostMicros: integer("ledger_cost_micros").notNull(),
		providerCostMicros: integer("provider_cost_micros").notNull(),
		varianceMicros: integer("variance_micros").notNull(),
		usageRowCount: integer("usage_row_count").notNull().default(0),
		status: text("status", { enum: BILLING_RECONCILIATION_STATUSES })
			.notNull()
			.default("pending"),
		evidenceRef: text("evidence_ref"),
		reconciledBy: text("reconciled_by"),
		reconciledAt: text("reconciled_at"),
		metadata: text("metadata", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_provider_reconciliation").on(
			table.provider,
			table.providerResource,
			table.periodStart,
			table.periodEnd,
		),
		index("idx_billing_provider_reconciliation_status").on(
			table.status,
			table.periodEnd,
		),
	],
);

export type BillingPlanVersion = typeof billingPlanVersions.$inferSelect;
export type NewBillingPlanVersion = typeof billingPlanVersions.$inferInsert;
export type BillingAccount = typeof billingAccounts.$inferSelect;
export type NewBillingAccount = typeof billingAccounts.$inferInsert;
export type BillingCreditEntry = typeof billingCreditEntries.$inferSelect;
export type NewBillingCreditEntry = typeof billingCreditEntries.$inferInsert;
export type BillingInferenceCapacityPackVersion =
	typeof billingInferenceCapacityPackVersions.$inferSelect;
export type NewBillingInferenceCapacityPackVersion =
	typeof billingInferenceCapacityPackVersions.$inferInsert;
export type BillingInferencePolicy =
	typeof billingInferencePolicies.$inferSelect;
export type NewBillingInferencePolicy =
	typeof billingInferencePolicies.$inferInsert;
export type BillingCapacityAllocation =
	typeof billingCapacityAllocations.$inferSelect;
export type NewBillingCapacityAllocation =
	typeof billingCapacityAllocations.$inferInsert;
export type BillingUsageReservation =
	typeof billingUsageReservations.$inferSelect;
export type NewBillingUsageReservation =
	typeof billingUsageReservations.$inferInsert;
export type BillingUsagePeriod = typeof billingUsagePeriods.$inferSelect;
export type NewBillingUsagePeriod = typeof billingUsagePeriods.$inferInsert;
export type BillingUsageQuarantine =
	typeof billingUsageQuarantines.$inferSelect;
export type NewBillingUsageQuarantine =
	typeof billingUsageQuarantines.$inferInsert;
export type BillingProviderUsage = typeof billingProviderUsage.$inferSelect;
export type NewBillingProviderUsage = typeof billingProviderUsage.$inferInsert;
export type BillingServiceRateCard =
	typeof billingServiceRateCards.$inferSelect;
export type NewBillingServiceRateCard =
	typeof billingServiceRateCards.$inferInsert;
export type BillingPlanServiceAllowance =
	typeof billingPlanServiceAllowances.$inferSelect;
export type NewBillingPlanServiceAllowance =
	typeof billingPlanServiceAllowances.$inferInsert;
export type BillingServiceCreditControl =
	typeof billingServiceCreditControls.$inferSelect;
export type NewBillingServiceCreditControl =
	typeof billingServiceCreditControls.$inferInsert;
export type BillingServiceCreditEntry =
	typeof billingServiceCreditEntries.$inferSelect;
export type NewBillingServiceCreditEntry =
	typeof billingServiceCreditEntries.$inferInsert;
export type BillingServiceCreditReservation =
	typeof billingServiceCreditReservations.$inferSelect;
export type NewBillingServiceCreditReservation =
	typeof billingServiceCreditReservations.$inferInsert;
export type BillingUsageCharge = typeof billingUsageCharges.$inferSelect;
export type NewBillingUsageCharge = typeof billingUsageCharges.$inferInsert;
export type StripeMeterOutboxRow = typeof stripeMeterOutbox.$inferSelect;
export type NewStripeMeterOutboxRow = typeof stripeMeterOutbox.$inferInsert;
export type StripeWebhookEvent = typeof stripeWebhookEvents.$inferSelect;
export type NewStripeWebhookEvent = typeof stripeWebhookEvents.$inferInsert;
export type BillingProviderReconciliation =
	typeof billingProviderReconciliations.$inferSelect;
export type NewBillingProviderReconciliation =
	typeof billingProviderReconciliations.$inferInsert;

/** Immutable server-audited root custody; UNKNOWN never implies zero or settlement. */
export const billingHistoricalExposures = sqliteTable(
	"billing_historical_exposures",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		tediId: text("tedi_id").notNull(),
		objectId: text("object_id").notNull(),
		objectName: text("object_name").notNull(),
		generation: integer("generation").notNull(),
		snapshotId: text("snapshot_id").notNull(),
		sourceHash: text("source_hash").notNull(),
		operationId: text("operation_id").notNull(),
		requestHash: text("request_hash").notNull(),
		exposure: text("exposure", { enum: ["UNKNOWN"] }).notNull(),
		payload: text("payload", { mode: "json" })
			.$type<import("@tedix/api-contract/schemas/billing").HistoricalExposure>()
			.notNull(),
		observedBy: text("observed_by").notNull(),
		observedUserId: text("observed_user_id").notNull(),
		observedAt: text("observed_at").notNull(),
	},
	(t) => [
		uniqueIndex("uniq_historical_exposure_operation").on(
			t.organizationId,
			t.tediId,
			t.operationId,
		),
		uniqueIndex("uniq_historical_exposure_source").on(
			t.organizationId,
			t.tediId,
			t.objectId,
			t.generation,
			t.snapshotId,
		),
		index("idx_historical_exposure_root").on(t.organizationId, t.tediId),
		check(
			"historical_exposure_unknown",
			sql`${t.exposure} = 'UNKNOWN' AND ${t.generation} > 0`,
		),
	],
);
/** Append-only human facts and explicit finite permission events; never an allocation or settlement. */
export const billingHistoricalDecisions = sqliteTable(
	"billing_historical_decisions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id").notNull(),
		tediId: text("tedi_id").notNull(),
		revision: integer("revision").notNull(),
		kind: text("kind", { enum: ["decision", "revocation"] }).notNull(),
		decisionId: text("decision_id"),
		operationId: text("operation_id").notNull(),
		requestHash: text("request_hash").notNull(),
		payload: text("payload", { mode: "json" })
			.$type<
				import("@tedix/api-contract/schemas/billing").HistoricalDecisionEvent
			>()
			.notNull(),
		recordedBy: text("recorded_by").notNull(),
		recordedUserId: text("recorded_user_id").notNull(),
		recordedAt: text("recorded_at").notNull(),
	},
	(t) => [
		uniqueIndex("uniq_historical_decision_revision").on(
			t.organizationId,
			t.tediId,
			t.revision,
		),
		uniqueIndex("uniq_historical_decision_operation").on(
			t.organizationId,
			t.tediId,
			t.operationId,
		),
		check(
			"historical_decision_kind",
			sql`${t.revision}>0 AND ((${t.kind}='decision' AND ${t.decisionId} IS NULL) OR (${t.kind}='revocation' AND ${t.decisionId} IS NOT NULL))`,
		),
	],
);
