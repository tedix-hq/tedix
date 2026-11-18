import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { organizations } from "./organizations";

const micros = (name: string) => bigint(name, { mode: "number" });

export const BILLING_PLAN_KEYS = [
	"starter",
	"growth",
	"business",
	"enterprise",
] as const;

export const BILLING_PLAN_STATUSES = ["draft", "active", "retired"] as const;

export const BILLING_ACCOUNT_STATUSES = [
	"trial",
	"active",
	"past_due",
	"cancelled",
	"suspended",
] as const;

export const BILLING_MODES = [
	"trial",
	"stripe",
	"invoice",
	"internal",
] as const;

export const BILLING_CREDIT_ENTRY_KINDS = [
	"grant",
	"debit",
	"refund",
	"adjustment",
] as const;

export const BILLING_INFERENCE_POLICY_SCOPES = [
	"organization",
	"tedi",
] as const;

export const INFERENCE_CAPACITY_PACK_STATUSES = [
	"draft",
	"active",
	"retired",
] as const;

export const BILLING_RESERVATION_STATUSES = [
	"reserved",
	"settled",
	"released",
	"rejected",
	"expired",
] as const;

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

export const BILLING_USAGE_QUALITIES = [
	"estimated",
	"gateway_reported",
	"provider_reported",
] as const;

export const BILLING_PROVIDER_COST_QUALITIES = [
	"estimated",
	"gateway_reported",
	"provider_reported",
	"provider_reconciled",
] as const;

export const BILLING_USAGE_QUARANTINE_REASONS = [
	"missing_reservation",
	"missing_billing_account",
	"missing_plan_version",
	"invalid_attribution",
	"unpriced_usage",
] as const;

export const BILLING_PROVIDER_USAGE_KINDS = [
	"voice_stt",
	"voice_tts",
	"image_generation",
	"seo_data",
	"workstation_compute",
	"other",
] as const;

export const BILLING_PROVIDER_USAGE_UNITS = [
	"seconds",
	"characters",
	"images",
	"compute_seconds",
	"units",
] as const;

export const BILLING_SERVICE_KEYS = ["seo"] as const;

export const BILLING_SERVICE_OPERATION_KEYS = [
	"research_keywords",
	"get_serp_results",
	"get_domain_overview",
	"get_backlinks_overview",
] as const;

export const BILLING_SERVICE_RATE_CARD_STATUSES = [
	"draft",
	"active",
	"retired",
] as const;

export const BILLING_SERVICE_CREDIT_ENTRY_KINDS = [
	"grant",
	"debit",
	"refund",
	"adjustment",
] as const;

export const BILLING_SERVICE_CREDIT_RESERVATION_STATUSES = [
	"reserved",
	"settled",
	"released",
	"expired",
	"rejected",
] as const;

export const STRIPE_METER_OUTBOX_STATUSES = [
	"pending",
	"sending",
	"sent",
	"failed",
	// Terminal dead-letter: the attempt ceiling was exhausted. Never re-claimed;
	// requires operator intervention (fix the Stripe entity, reset to pending).
	"dead",
] as const;

export const STRIPE_WEBHOOK_EVENT_STATUSES = [
	"processing",
	"processed",
	"failed",
] as const;

export const BILLING_RECONCILIATION_STATUSES = [
	"pending",
	"matched",
	"variance",
	"approved",
] as const;

export const billingPlanVersions = pgTable(
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
		monthlyPriceMicros: micros("monthly_price_micros").notNull().default(0),
		annualPriceMicros: micros("annual_price_micros").notNull().default(0),
		includedMonthlyTokens: bigint("included_monthly_tokens", {
			mode: "number",
		}).notNull(),
		includedMonthlyCreditMicros: micros("included_monthly_credit_micros")
			.notNull()
			.default(0),
		overageUnitTokens: bigint("overage_unit_tokens", { mode: "number" })
			.notNull()
			.default(1_000),
		overageUnitPriceMicros: micros("overage_unit_price_micros")
			.notNull()
			.default(0),
		maxTedis: integer("max_tedis").notNull(),
		maxCronJobsPerTedi: integer("max_cron_jobs_per_tedi").notNull(),
		maxIterationsPerTask: integer("max_iterations_per_task").notNull(),
		defaultDailyTokenLimit: bigint("default_daily_token_limit", {
			mode: "number",
		}).notNull(),
		defaultDailyMessageLimit: integer("default_daily_message_limit").notNull(),
		allowOverage: boolean("allow_overage").notNull().default(false),
		metadata: jsonb("metadata")
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		effectiveAt: text("effective_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
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

export const billingAccounts = pgTable(
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
		stripeCancelAtPeriodEnd: boolean("stripe_cancel_at_period_end"),
		periodStart: text("period_start").notNull(),
		periodEnd: text("period_end").notNull(),
		overageEnabled: boolean("overage_enabled").notNull().default(false),
		hardSpendLimitMicros: micros("hard_spend_limit_micros"),
		creditBalanceMicros: micros("credit_balance_micros").notNull().default(0),
		graceEndsAt: text("grace_ends_at"),
		entitlementVersion: integer("entitlement_version").notNull().default(1),
		metadata: jsonb("metadata")
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
	},
	(table) => [
		index("idx_billing_account_status").on(table.status, table.periodEnd),
		uniqueIndex("uniq_billing_account_stripe_customer")
			.on(table.stripeEnvironment, table.stripeCustomerId)
			.where(sql`${table.stripeCustomerId} IS NOT NULL`),
		uniqueIndex("uniq_billing_account_stripe_subscription")
			.on(table.stripeEnvironment, table.stripeSubscriptionId)
			.where(sql`${table.stripeSubscriptionId} IS NOT NULL`),
		index("idx_billing_account_plan").on(table.planVersionId),
	],
);

export const billingCreditEntries = pgTable(
	"billing_credit_entries",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		kind: text("kind", { enum: BILLING_CREDIT_ENTRY_KINDS }).notNull(),
		amountMicros: micros("amount_micros").notNull(),
		sourceType: text("source_type").notNull(),
		sourceRef: text("source_ref"),
		usageChargeId: text("usage_charge_id"),
		idempotencyKey: text("idempotency_key").notNull(),
		expiresAt: text("expires_at"),
		description: text("description"),
		metadata: jsonb("metadata")
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
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
		check("chk_billing_credit_nonzero", sql`${table.amountMicros} <> 0`),
		check(
			"chk_billing_credit_direction",
			sql`(${table.kind} IN ('grant', 'refund') AND ${table.amountMicros} > 0) OR (${table.kind} = 'debit' AND ${table.amountMicros} < 0) OR ${table.kind} = 'adjustment'`,
		),
	],
);

export const billingUsageReservations = pgTable(
	"billing_usage_reservations",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		planVersionId: text("plan_version_id")
			.notNull()
			.references(() => billingPlanVersions.id),
		tediId: text("tedi_id"),
		status: text("status", { enum: BILLING_RESERVATION_STATUSES })
			.notNull()
			.default("reserved"),
		source: text("source", { enum: BILLING_USAGE_SOURCES }).notNull(),
		provider: text("provider").notNull(),
		model: text("model").notNull(),
		estimatedInputTokens: bigint("estimated_input_tokens", { mode: "number" })
			.notNull()
			.default(0),
		estimatedOutputTokens: bigint("estimated_output_tokens", { mode: "number" })
			.notNull()
			.default(0),
		estimatedChargeMicros: micros("estimated_charge_micros")
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
		metadata: jsonb("metadata")
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
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
		index("idx_billing_reservation_status_expiry").on(
			table.status,
			table.expiresAt,
		),
		index("idx_billing_reservation_org_created").on(
			table.organizationId,
			table.createdAt,
		),
	],
);

export type PgBillingUsageReservation =
	typeof billingUsageReservations.$inferSelect;

export const billingUsagePeriods = pgTable(
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
		includedTokens: bigint("included_tokens", { mode: "number" }).notNull(),
		usedInputTokens: bigint("used_input_tokens", { mode: "number" })
			.notNull()
			.default(0),
		usedOutputTokens: bigint("used_output_tokens", { mode: "number" })
			.notNull()
			.default(0),
		meteredOverageTokens: bigint("metered_overage_tokens", { mode: "number" })
			.notNull()
			.default(0),
		providerCostMicros: bigint("provider_cost_micros", { mode: "number" })
			.notNull()
			.default(0),
		customerChargeMicros: bigint("customer_charge_micros", { mode: "number" })
			.notNull()
			.default(0),
		creditAppliedMicros: bigint("credit_applied_micros", { mode: "number" })
			.notNull()
			.default(0),
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
			.default(sql`CURRENT_TIMESTAMP::text`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
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

export const billingUsageCharges = pgTable(
	"billing_usage_charges",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id"),
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
		inputTokens: bigint("input_tokens", { mode: "number" })
			.notNull()
			.default(0),
		outputTokens: bigint("output_tokens", { mode: "number" })
			.notNull()
			.default(0),
		includedTokensApplied: bigint("included_tokens_applied", { mode: "number" })
			.notNull()
			.default(0),
		meteredOverageTokens: bigint("metered_overage_tokens", { mode: "number" })
			.notNull()
			.default(0),
		providerCostMicros: bigint("provider_cost_micros", { mode: "number" })
			.notNull()
			.default(0),
		customerChargeMicros: bigint("customer_charge_micros", { mode: "number" })
			.notNull()
			.default(0),
		creditAppliedMicros: bigint("credit_applied_micros", { mode: "number" })
			.notNull()
			.default(0),
		usageQuality: text("usage_quality", { enum: BILLING_USAGE_QUALITIES })
			.notNull()
			.default("gateway_reported"),
		providerCostQuality: text("provider_cost_quality", {
			enum: BILLING_PROVIDER_COST_QUALITIES,
		})
			.notNull()
			.default("estimated"),
		meteringReady: boolean("metering_ready").notNull().default(false),
		providerReconciledAt: text("provider_reconciled_at"),
		rateCardVersion: text("rate_card_version"),
		occurredAt: text("occurred_at").notNull(),
		metadata: jsonb("metadata")
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
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
		// Only EUR monetary charges count toward monetary period spend; its
		// predicate must match monetaryPeriodSpendSql's JSON predicate.
		index("idx_billing_charge_monetary_eur")
			.on(table.organizationId, table.occurredAt)
			.where(
				sql`metadata #> '{monetaryQuote,schemaVersion}' IN ('1'::jsonb, 'true'::jsonb) AND metadata #>> '{monetaryQuote,rateSnapshot,customerCurrency}' = 'EUR'`,
			),
		index("idx_billing_charge_reservation").on(table.reservationId),
		index("idx_billing_charge_metering").on(
			table.meteringReady,
			table.usageQuality,
			table.occurredAt,
		),
	],
);

export const billingProviderUsage = pgTable(
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
		quantity: bigint("quantity", { mode: "number" }).notNull(),
		providerCostMicros: bigint("provider_cost_micros", { mode: "number" })
			.notNull()
			.default(0),
		providerCostQuality: text("provider_cost_quality", {
			enum: BILLING_PROVIDER_COST_QUALITIES,
		})
			.notNull()
			.default("estimated"),
		customerMeteringReady: boolean("customer_metering_ready")
			.notNull()
			.default(false),
		occurredAt: text("occurred_at").notNull(),
		metadata: jsonb("metadata")
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
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

export const billingServiceRateCards = pgTable(
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
		creditCost: bigint("credit_cost", { mode: "number" }).notNull(),
		/** Display/accounting value of one consumed credit in USD micros. */
		customerValueMicros: bigint("customer_value_micros", {
			mode: "number",
		}).notNull(),
		/** Admission ceiling used to bound provider spend before the call. */
		providerCostCeilingMicros: bigint("provider_cost_ceiling_micros", {
			mode: "number",
		}).notNull(),
		effectiveAt: text("effective_at").notNull(),
		metadata: jsonb("metadata")
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
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

export const billingPlanServiceAllowances = pgTable(
	"billing_plan_service_allowances",
	{
		id: text("id").primaryKey(),
		planVersionId: text("plan_version_id")
			.notNull()
			.references(() => billingPlanVersions.id),
		serviceKey: text("service_key", { enum: BILLING_SERVICE_KEYS }).notNull(),
		includedCredits: bigint("included_credits", { mode: "number" }).notNull(),
		perTediMonthlyLimit: bigint("per_tedi_monthly_limit", { mode: "number" }),
		monthlyProviderCostLimitMicros: bigint(
			"monthly_provider_cost_limit_micros",
			{ mode: "number" },
		),
		createdAt: text("created_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
	},
	(table) => [
		uniqueIndex("uniq_billing_plan_service_allowance").on(
			table.planVersionId,
			table.serviceKey,
		),
	],
);

export const billingServiceCreditControls = pgTable(
	"billing_service_credit_controls",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		serviceKey: text("service_key", { enum: BILLING_SERVICE_KEYS }).notNull(),
		enabled: boolean("enabled").notNull().default(true),
		monthlyCreditLimit: bigint("monthly_credit_limit", { mode: "number" }),
		perTediMonthlyLimit: bigint("per_tedi_monthly_limit", { mode: "number" }),
		monthlyProviderCostLimitMicros: bigint(
			"monthly_provider_cost_limit_micros",
			{ mode: "number" },
		),
		updatedBy: text("updated_by"),
		metadata: jsonb("metadata")
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
	},
	(table) => [
		uniqueIndex("uniq_billing_service_credit_control").on(
			table.organizationId,
			table.serviceKey,
		),
	],
);

export const billingServiceCreditEntries = pgTable(
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
		amountCredits: bigint("amount_credits", { mode: "number" }).notNull(),
		sourceType: text("source_type").notNull(),
		sourceRef: text("source_ref"),
		reservationId: text("reservation_id"),
		idempotencyKey: text("idempotency_key").notNull(),
		expiresAt: text("expires_at"),
		description: text("description"),
		metadata: jsonb("metadata")
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
	},
	(table) => [
		check("chk_service_credit_nonzero", sql`${table.amountCredits} <> 0`),
		check(
			"chk_service_credit_direction",
			sql`(${table.kind} IN ('grant','refund') AND ${table.amountCredits} > 0) OR (${table.kind} = 'debit' AND ${table.amountCredits} < 0) OR ${table.kind} = 'adjustment'`,
		),
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

export const billingServiceCreditReservations = pgTable(
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
		tediId: text("tedi_id"),
		serviceKey: text("service_key", { enum: BILLING_SERVICE_KEYS }).notNull(),
		operationKey: text("operation_key", {
			enum: BILLING_SERVICE_OPERATION_KEYS,
		}).notNull(),
		status: text("status", {
			enum: BILLING_SERVICE_CREDIT_RESERVATION_STATUSES,
		})
			.notNull()
			.default("reserved"),
		creditsReserved: bigint("credits_reserved", { mode: "number" }).notNull(),
		customerValueMicros: bigint("customer_value_micros", {
			mode: "number",
		}).notNull(),
		providerCostCeilingMicros: bigint("provider_cost_ceiling_micros", {
			mode: "number",
		}).notNull(),
		actualProviderCostMicros: bigint("actual_provider_cost_micros", {
			mode: "number",
		}),
		providerUsageId: text("provider_usage_id"),
		periodStart: text("period_start").notNull(),
		periodEnd: text("period_end").notNull(),
		idempotencyKey: text("idempotency_key").notNull(),
		rejectionCode: text("rejection_code"),
		expiresAt: text("expires_at").notNull(),
		settledAt: text("settled_at"),
		releasedAt: text("released_at"),
		metadata: jsonb("metadata")
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
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

export const stripeMeterOutbox = pgTable(
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
		quantity: bigint("quantity", { mode: "number" }).notNull(),
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
			.default(sql`CURRENT_TIMESTAMP::text`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
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

export const stripeWebhookEvents = pgTable(
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
			.default(sql`CURRENT_TIMESTAMP::text`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
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

export type BillingPlanKey = (typeof BILLING_PLAN_KEYS)[number];
export type BillingPlanStatus = (typeof BILLING_PLAN_STATUSES)[number];
export type BillingAccountStatus = (typeof BILLING_ACCOUNT_STATUSES)[number];
export type BillingMode = (typeof BILLING_MODES)[number];
export type BillingCreditEntryKind =
	(typeof BILLING_CREDIT_ENTRY_KINDS)[number];
export type BillingInferencePolicyScope =
	(typeof BILLING_INFERENCE_POLICY_SCOPES)[number];
export type InferenceCapacityPackStatus =
	(typeof INFERENCE_CAPACITY_PACK_STATUSES)[number];
export type BillingReservationStatus =
	(typeof BILLING_RESERVATION_STATUSES)[number];
export type BillingUsageSource = (typeof BILLING_USAGE_SOURCES)[number];
export type BillingUsageQuality = (typeof BILLING_USAGE_QUALITIES)[number];
export type BillingProviderCostQuality =
	(typeof BILLING_PROVIDER_COST_QUALITIES)[number];
export type BillingUsageQuarantineReason =
	(typeof BILLING_USAGE_QUARANTINE_REASONS)[number];
export type BillingProviderUsageKind =
	(typeof BILLING_PROVIDER_USAGE_KINDS)[number];
export type BillingProviderUsageUnit =
	(typeof BILLING_PROVIDER_USAGE_UNITS)[number];
export type BillingServiceKey = (typeof BILLING_SERVICE_KEYS)[number];
export type BillingServiceOperationKey =
	(typeof BILLING_SERVICE_OPERATION_KEYS)[number];
export type BillingServiceRateCardStatus =
	(typeof BILLING_SERVICE_RATE_CARD_STATUSES)[number];
export type BillingServiceCreditEntryKind =
	(typeof BILLING_SERVICE_CREDIT_ENTRY_KINDS)[number];
export type BillingServiceCreditReservationStatus =
	(typeof BILLING_SERVICE_CREDIT_RESERVATION_STATUSES)[number];
export type StripeMeterOutboxStatus =
	(typeof STRIPE_METER_OUTBOX_STATUSES)[number];
export type StripeWebhookEventStatus =
	(typeof STRIPE_WEBHOOK_EVENT_STATUSES)[number];
export type BillingReconciliationStatus =
	(typeof BILLING_RECONCILIATION_STATUSES)[number];
export type BillingPlanVersion = typeof billingPlanVersions.$inferSelect;
export type NewBillingPlanVersion = typeof billingPlanVersions.$inferInsert;
export type BillingAccount = typeof billingAccounts.$inferSelect;
export type NewBillingAccount = typeof billingAccounts.$inferInsert;
export type BillingCreditEntry = typeof billingCreditEntries.$inferSelect;
export type NewBillingCreditEntry = typeof billingCreditEntries.$inferInsert;
export type BillingUsageReservation =
	typeof billingUsageReservations.$inferSelect;
export type NewBillingUsageReservation =
	typeof billingUsageReservations.$inferInsert;
export type BillingUsagePeriod = typeof billingUsagePeriods.$inferSelect;
export type NewBillingUsagePeriod = typeof billingUsagePeriods.$inferInsert;
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

export const billingInferenceCapacityPackVersions = pgTable(
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
		priceMicros: bigint("price_micros", { mode: "number" }).notNull(),
		tokenAmount: bigint("token_amount", { mode: "number" }).notNull(),
		spendAmountMicros: bigint("spend_amount_micros", {
			mode: "number",
		}).notNull(),
		stripeEnvironment: text("stripe_environment", {
			enum: ["test", "live"],
		}).notNull(),
		stripeLookupKey: text("stripe_lookup_key").notNull(),
		metadata: jsonb("metadata")
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		effectiveAt: text("effective_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
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

export const billingCapacityAllocations = pgTable(
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
		tokenAmount: bigint("token_amount", { mode: "number" })
			.notNull()
			.default(0),
		spendAmountMicros: bigint("spend_amount_micros", { mode: "number" })
			.notNull()
			.default(0),
		sourceType: text("source_type").notNull(),
		sourceRef: text("source_ref"),
		idempotencyKey: text("idempotency_key").notNull(),
		stripeEnvironment: text("stripe_environment", {
			enum: ["test", "live"],
		}).notNull(),
		expiresAt: text("expires_at").notNull(),
		metadata: jsonb("metadata")
			.$type<Record<string, JsonValue>>()
			.notNull()
			.default({}),
		createdAt: text("created_at")
			.notNull()
			.default(sql`CURRENT_TIMESTAMP::text`),
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

export type BillingInferenceCapacityPackVersion =
	typeof billingInferenceCapacityPackVersions.$inferSelect;

export type NewBillingInferenceCapacityPackVersion =
	typeof billingInferenceCapacityPackVersions.$inferInsert;

export type BillingCapacityAllocation =
	typeof billingCapacityAllocations.$inferSelect;

export type NewBillingCapacityAllocation =
	typeof billingCapacityAllocations.$inferInsert;
