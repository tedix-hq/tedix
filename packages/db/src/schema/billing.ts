/**
 * Canonical Tedix billing, entitlement, credit, and metered-usage schema.
 *
 * D1 is the financial control-plane source of truth. Provider ledgers and
 * Stripe are projections: provider rows settle reservations, while a durable
 * outbox exports pay-as-you-go credits without making either vendor
 * authoritative.
 *
 * Customers are billed and limited in Tedix credits (1 credit = EUR 0.01)
 * from one monthly pool per organization. Provider cost stays in USD micros
 * and token counts stay as cost evidence; neither is a customer limit.
 */

import type { CreditFxRate } from "@tedix/api-contract/schemas/billing";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	primaryKey,
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
		/** Tedix credits included each billing period (1 credit = EUR 0.01). */
		includedMonthlyCredits: integer("included_monthly_credits")
			.notNull()
			.default(0),
		/** ECB reference rate pinned for converting USD provider cost to EUR credits. */
		creditFx: text("credit_fx", { mode: "json" }).$type<CreditFxRate>(),
		maxTedis: integer("max_tedis").notNull(),
		maxCronJobsPerTedi: integer("max_cron_jobs_per_tedi").notNull(),
		maxIterationsPerTask: integer("max_iterations_per_task").notNull(),
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
		stripeWebhookCustomerKey: text("stripe_webhook_customer_key"),
		stripeWebhookEventCreatedAt: integer("stripe_webhook_event_created_at"),
		periodStart: text("period_start").notNull(),
		periodEnd: text("period_end").notNull(),
		/**
		 * Admin opt-in for priced overage. Off by default: a plan that sells
		 * overage still stops at its included allowance until an organization
		 * admin turns this on, and `hard_spend_limit_micros` then carries the
		 * monthly cap (plan currency) at which admission stops again.
		 */
		overageEnabled: integer("overage_enabled", { mode: "boolean" })
			.notNull()
			.default(false),
		hardSpendLimitMicros: integer("hard_spend_limit_micros"),
		/** Operator-set included credits per period; null uses the plan value. */
		includedCreditsOverride: integer("included_credits_override"),
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

/**
 * True for every reservation: `created_at` is text and never null, and no text
 * sorts before the empty string. It is the WHERE of
 * idx_billing_reservation_newest and of the one read that uses it, word for
 * word. SQLite offers a partial index only to a query that states the index's
 * condition, so this keeps an index on the creation time alone away from
 * every other read of reservations, which all name an organization or a tedi.
 *
 * The unary plus stops SQLite from taking this as the start of the range it
 * walks. The read's own cutoff is then the only bound, so when no reservation
 * is recent enough the walk ends at once instead of crossing the whole index.
 */
export const anyBillingReservation = sql`+created_at >= ''`;

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
		/** Credits held from the pool until the call settles. */
		credits: integer("credits").notNull().default(0),
		/** Member who started the work, for per-member monthly caps. */
		userId: text("user_id"),
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
		index("idx_billing_reservation_status_expiry").on(
			table.status,
			table.expiresAt,
		),
		index("idx_billing_reservation_plan").on(table.planVersionId),
		index("idx_billing_reservation_tedi_created").on(
			table.tediId,
			table.createdAt,
		),
		// The daily organization gates read one UTC day of an organization's
		// reservations by created_at; without this they walked every status.
		index("idx_billing_reservation_org_created").on(
			table.organizationId,
			table.createdAt,
		),
		// The metering check asks for the newest reservation of all
		// organizations; without this it walked the whole table.
		index("idx_billing_reservation_newest")
			.on(table.createdAt)
			.where(anyBillingReservation),
		// Run spending reads charges by run; without this each read walked every
		// reservation of the organization.
		index("idx_billing_reservation_org_run").on(
			table.organizationId,
			table.runId,
		),
	],
);

/**
 * One usage period per org: token counts and provider cost of settled AI
 * calls, kept as cost evidence. Credits live in billing_credit_usage_totals.
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
		usedInputTokens: integer("used_input_tokens").notNull().default(0),
		usedOutputTokens: integer("used_output_tokens").notNull().default(0),
		providerCostMicros: integer("provider_cost_micros").notNull().default(0),
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
		/** Credits drawn from the pool for this call, from its provider cost. */
		credits: integer("credits").notNull().default(0),
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
		// Only EUR monetary charges count toward monetary period spend; its
		// predicate must match monetaryPeriodSpendSql's json_extract terms.
		index("idx_billing_charge_monetary_eur")
			.on(table.organizationId, table.occurredAt)
			.where(
				sql`json_extract(metadata,'$.monetaryQuote.schemaVersion')=1 AND json_extract(metadata,'$.monetaryQuote.rateSnapshot.customerCurrency')='EUR'`,
			),
		index("idx_billing_charge_reservation").on(table.reservationId),
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

/**
 * Settlement watermark over `tedi_call_costs` insertion order (rowid). The
 * frequent settlement tick reads only rows above `afterRowid`; a periodic full
 * sweep (`fullSweepAt`) re-checks the whole ledger for anything the watermark
 * skipped, so the cursor bounds cost without becoming a correctness boundary.
 */
export const billingSettlementCursors = sqliteTable(
	"billing_settlement_cursors",
	{
		name: text("name").primaryKey(),
		afterRowid: integer("after_rowid").notNull(),
		fullSweepAt: text("full_sweep_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
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

export const BILLING_SERVICE_KEYS = ["seo", "web_search"] as const;
export type BillingServiceKey = (typeof BILLING_SERVICE_KEYS)[number];

export const BILLING_SERVICE_OPERATION_KEYS = [
	"research_keywords",
	"get_serp_results",
	"get_domain_overview",
	"get_backlinks_overview",
	"search",
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
		/** Member who started the operation, for per-member monthly caps. */
		userId: text("user_id"),
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

export const BILLING_TOP_UP_PACK_STATUSES = [
	"draft",
	"active",
	"retired",
] as const;
export type BillingTopUpPackStatus =
	(typeof BILLING_TOP_UP_PACK_STATUSES)[number];

/** Immutable commercial version of one one-time credit top-up pack. */
export const billingTopUpPackVersions = sqliteTable(
	"billing_top_up_pack_versions",
	{
		id: text("id").primaryKey(),
		packKey: text("pack_key").notNull(),
		version: integer("version").notNull(),
		status: text("status", { enum: BILLING_TOP_UP_PACK_STATUSES })
			.notNull()
			.default("draft"),
		name: text("name").notNull(),
		currency: text("currency").notNull().default("eur"),
		priceMicros: integer("price_micros").notNull(),
		credits: integer("credits").notNull(),
		validMonths: integer("valid_months").notNull(),
		stripeEnvironment: text("stripe_environment", {
			enum: ["test", "live"],
		}).notNull(),
		stripeLookupKey: text("stripe_lookup_key").notNull(),
		effectiveAt: text("effective_at").notNull(),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_top_up_pack_version").on(
			table.packKey,
			table.version,
			table.stripeEnvironment,
		),
		uniqueIndex("uniq_billing_top_up_pack_lookup").on(
			table.stripeEnvironment,
			table.stripeLookupKey,
		),
		index("idx_billing_top_up_pack_active").on(
			table.stripeEnvironment,
			table.status,
			table.effectiveAt,
		),
		check(
			"chk_billing_top_up_pack_positive",
			sql`${table.priceMicros} > 0 AND ${table.credits} > 0 AND ${table.validMonths} > 0`,
		),
	],
);

export const BILLING_TOP_UP_SOURCES = [
	"stripe_checkout",
	"operator_grant",
	"wallet_conversion",
	"service_credit_conversion",
] as const;
export type BillingTopUpSource = (typeof BILLING_TOP_UP_SOURCES)[number];

/**
 * Purchased or granted credits that outlive one billing period. Included
 * credits are spent first, then the top-up that expires soonest.
 */
export const billingCreditTopUps = sqliteTable(
	"billing_credit_top_ups",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		credits: integer("credits").notNull(),
		consumedCredits: integer("consumed_credits").notNull().default(0),
		sourceType: text("source_type", { enum: BILLING_TOP_UP_SOURCES }).notNull(),
		sourceRef: text("source_ref"),
		packVersionId: text("pack_version_id").references(
			() => billingTopUpPackVersions.id,
		),
		idempotencyKey: text("idempotency_key").notNull(),
		expiresAt: text("expires_at").notNull(),
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
		uniqueIndex("uniq_billing_credit_top_up_idempotency").on(
			table.idempotencyKey,
		),
		index("idx_billing_credit_top_up_org_expiry").on(
			table.organizationId,
			table.expiresAt,
		),
		check(
			"chk_billing_credit_top_up_amounts",
			sql`${table.credits} > 0 AND ${table.consumedCredits} >= 0 AND ${table.consumedCredits} <= ${table.credits}`,
		),
	],
);

export const BILLING_CREDIT_KINDS = ["ai", "code_run", "service"] as const;
export type BillingCreditKind = (typeof BILLING_CREDIT_KINDS)[number];

/**
 * Immutable record of credits drawn from the pool: one row per settled AI
 * call, code run, or service operation, split into the included, top-up and
 * pay-as-you-go parts it consumed.
 */
export const billingCreditConsumptions = sqliteTable(
	"billing_credit_consumptions",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		tediId: text("tedi_id").references(() => tedis.id, {
			onDelete: "set null",
		}),
		userId: text("user_id"),
		kind: text("kind", { enum: BILLING_CREDIT_KINDS }).notNull(),
		/** Charge, code-run or service reservation id; unique per kind. */
		sourceRef: text("source_ref").notNull(),
		periodStart: text("period_start").notNull(),
		periodEnd: text("period_end").notNull(),
		credits: integer("credits").notNull(),
		includedCredits: integer("included_credits").notNull(),
		topUpCredits: integer("top_up_credits").notNull(),
		paygCredits: integer("payg_credits").notNull(),
		/** EUR micros owed for pay-as-you-go credits; zero when not opted in. */
		paygChargeMicros: integer("payg_charge_micros").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		uniqueIndex("uniq_billing_credit_consumption_source").on(
			table.kind,
			table.sourceRef,
		),
		index("idx_billing_credit_consumption_org_period").on(
			table.organizationId,
			table.periodStart,
		),
		check(
			"chk_billing_credit_consumption_split",
			sql`${table.credits} >= 0 AND ${table.includedCredits} >= 0 AND ${table.topUpCredits} >= 0 AND ${table.paygCredits} >= 0 AND ${table.includedCredits} + ${table.topUpCredits} + ${table.paygCredits} = ${table.credits} AND ${table.paygChargeMicros} >= 0`,
		),
	],
);

export const BILLING_CREDIT_SUBJECT_KINDS = [
	"organization",
	"tedi",
	"member",
] as const;
export type BillingCreditSubjectKind =
	(typeof BILLING_CREDIT_SUBJECT_KINDS)[number];

/**
 * Running credit totals per billing period for the organization, each tedi
 * and each member. Admission reads one row per subject instead of summing
 * the period's consumptions.
 */
export const billingCreditUsageTotals = sqliteTable(
	"billing_credit_usage_totals",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		periodStart: text("period_start").notNull(),
		periodEnd: text("period_end").notNull(),
		subjectKind: text("subject_kind", {
			enum: BILLING_CREDIT_SUBJECT_KINDS,
		}).notNull(),
		/** `organization`, the tedi id, or the member user id. */
		subjectKey: text("subject_key").notNull(),
		aiCredits: integer("ai_credits").notNull().default(0),
		codeRunCredits: integer("code_run_credits").notNull().default(0),
		serviceCredits: integer("service_credits").notNull().default(0),
		includedCredits: integer("included_credits").notNull().default(0),
		topUpCredits: integer("top_up_credits").notNull().default(0),
		paygCredits: integer("payg_credits").notNull().default(0),
		paygChargeMicros: integer("payg_charge_micros").notNull().default(0),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		primaryKey({
			columns: [
				table.organizationId,
				table.periodStart,
				table.subjectKind,
				table.subjectKey,
			],
		}),
	],
);

export const BILLING_CREDIT_CAP_SUBJECT_KINDS = ["tedi", "member"] as const;
export type BillingCreditCapSubjectKind =
	(typeof BILLING_CREDIT_CAP_SUBJECT_KINDS)[number];

/** Admin-set monthly credit caps for one tedi or member; no row means no cap. */
export const billingCreditCaps = sqliteTable(
	"billing_credit_caps",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		subjectKind: text("subject_kind", {
			enum: BILLING_CREDIT_CAP_SUBJECT_KINDS,
		}).notNull(),
		subjectKey: text("subject_key").notNull(),
		monthlyCapCredits: integer("monthly_cap_credits").notNull(),
		updatedBy: text("updated_by"),
		createdAt: text("created_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
		updatedAt: text("updated_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		primaryKey({
			columns: [table.organizationId, table.subjectKind, table.subjectKey],
		}),
		check(
			"chk_billing_credit_cap_nonnegative",
			sql`${table.monthlyCapCredits} >= 0`,
		),
	],
);

/** The 80% and 100% usage notices, raised once per billing period. */
export const billingCreditNotices = sqliteTable(
	"billing_credit_notices",
	{
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		periodStart: text("period_start").notNull(),
		threshold: integer("threshold").notNull(),
		reachedAt: text("reached_at").notNull(),
		/** Set once the notice's admin deliveries are queued; null = not yet. */
		deliveriesPlannedAt: text("deliveries_planned_at"),
	},
	(table) => [
		primaryKey({
			columns: [table.organizationId, table.periodStart, table.threshold],
		}),
		check(
			"chk_billing_credit_notice_threshold",
			sql`${table.threshold} IN (80, 100)`,
		),
		index("idx_billing_credit_notices_unplanned")
			.on(table.reachedAt)
			.where(sql`${table.deliveriesPlannedAt} IS NULL`),
	],
);

export const CREDIT_NOTICE_DELIVERY_CHANNELS = ["deck", "email"] as const;
export type CreditNoticeDeliveryChannel =
	(typeof CREDIT_NOTICE_DELIVERY_CHANNELS)[number];

export const CREDIT_NOTICE_DELIVERY_STATUSES = [
	"pending",
	"sending",
	"sent",
	"failed",
	// Terminal: the attempt ceiling was reached.
	"dead",
	// Terminal: the billing period ended before delivery; the notice is stale.
	"expired",
] as const;
export type CreditNoticeDeliveryStatus =
	(typeof CREDIT_NOTICE_DELIVERY_STATUSES)[number];

/**
 * Durable outbox telling each organization admin about a usage notice: one
 * row per notice, channel and admin. The id is deterministic, so planning
 * twice queues nothing new, and a row marked sent is never claimed again.
 */
export const billingCreditNoticeDeliveries = sqliteTable(
	"billing_credit_notice_deliveries",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		periodStart: text("period_start").notNull(),
		threshold: integer("threshold").notNull(),
		channel: text("channel", {
			enum: CREDIT_NOTICE_DELIVERY_CHANNELS,
		}).notNull(),
		recipientUserId: text("recipient_user_id").notNull(),
		recipientEmail: text("recipient_email").notNull(),
		status: text("status", { enum: CREDIT_NOTICE_DELIVERY_STATUSES })
			.notNull()
			.default("pending"),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: text("next_attempt_at").notNull(),
		leaseExpiresAt: text("lease_expires_at"),
		/** The Deck card id or the email provider's message id. */
		deliveryRef: text("delivery_ref"),
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
		uniqueIndex("uniq_billing_credit_notice_delivery").on(
			table.organizationId,
			table.periodStart,
			table.threshold,
			table.channel,
			table.recipientUserId,
		),
		index("idx_billing_credit_notice_delivery_retry").on(
			table.status,
			table.nextAttemptAt,
		),
		check(
			"chk_billing_credit_notice_delivery_threshold",
			sql`${table.threshold} IN (80, 100)`,
		),
	],
);

/** Durable, idempotent export of pay-as-you-go credits to the Stripe meter. */
export const billingCreditMeterOutbox = sqliteTable(
	"billing_credit_meter_outbox",
	{
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		consumptionId: text("consumption_id")
			.notNull()
			.references(() => billingCreditConsumptions.id, {
				onDelete: "cascade",
			}),
		stripeCustomerId: text("stripe_customer_id").notNull(),
		stripeEnvironment: text("stripe_environment", {
			enum: ["test", "live"],
		}).notNull(),
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
		uniqueIndex("uniq_billing_credit_meter_outbox_idempotency").on(
			table.idempotencyKey,
		),
		uniqueIndex("uniq_billing_credit_meter_outbox_consumption").on(
			table.consumptionId,
		),
		index("idx_billing_credit_meter_outbox_retry").on(
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

export type BillingTopUpPackVersion =
	typeof billingTopUpPackVersions.$inferSelect;
export type BillingCreditTopUp = typeof billingCreditTopUps.$inferSelect;
export type BillingCreditConsumption =
	typeof billingCreditConsumptions.$inferSelect;
export type BillingCreditUsageTotal =
	typeof billingCreditUsageTotals.$inferSelect;
export type BillingCreditCap = typeof billingCreditCaps.$inferSelect;
export type BillingCreditNotice = typeof billingCreditNotices.$inferSelect;
export type BillingCreditNoticeDelivery =
	typeof billingCreditNoticeDeliveries.$inferSelect;
export type BillingPlanVersion = typeof billingPlanVersions.$inferSelect;
export type NewBillingPlanVersion = typeof billingPlanVersions.$inferInsert;
export type BillingAccount = typeof billingAccounts.$inferSelect;
export type NewBillingAccount = typeof billingAccounts.$inferInsert;
export type BillingInferencePolicy =
	typeof billingInferencePolicies.$inferSelect;
export type NewBillingInferencePolicy =
	typeof billingInferencePolicies.$inferInsert;
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
export type BillingServiceCreditControl =
	typeof billingServiceCreditControls.$inferSelect;
export type NewBillingServiceCreditControl =
	typeof billingServiceCreditControls.$inferInsert;
export type BillingServiceCreditReservation =
	typeof billingServiceCreditReservations.$inferSelect;
export type NewBillingServiceCreditReservation =
	typeof billingServiceCreditReservations.$inferInsert;
export type BillingUsageCharge = typeof billingUsageCharges.$inferSelect;
export type NewBillingUsageCharge = typeof billingUsageCharges.$inferInsert;
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

/** Immutable billing-domain provider-estimate evidence; no source or authority FK. */
export const billingProviderCostEvidenceVersions = sqliteTable(
	"billing_provider_cost_evidence_versions",
	{
		id: text("id").primaryKey(),
		originalOrgId: text("original_org_id").notNull(),
		sourceGatewayId: text("source_gateway_id").notNull(),
		gatewayLogId: text("gateway_log_id").notNull(),
		sourceCallId: text("source_call_id").notNull(),
		scopeDigest: text("scope_digest").notNull(),
		originalSourceDigest: text("original_source_digest").notNull(),
		occurredAt: text("occurred_at").notNull(),
		recordedAt: text("recorded_at").notNull(),
		provider: text("provider").notNull(),
		nativeModel: text("native_model").notNull(),
		nativeFactsReceiptDigest: text("native_facts_receipt_digest").notNull(),
		basisFactsDigest: text("basis_facts_digest").notNull(),
		financialManifestDigest: text("financial_manifest_digest").notNull(),
		financialWorkId: text("financial_work_id").notNull(),
		financialSpecRevision: text("financial_spec_revision").notNull(),
		approvalProposalId: text("approval_proposal_id").notNull(),
		approvalDecisionId: text("approval_decision_id").notNull(),
		attemptId: text("attempt_id").notNull(),
		admissionId: text("admission_id").notNull(),
		createdByActorType: text("created_by_actor_type").notNull(),
		createdByActorId: text("created_by_actor_id").notNull(),
		createdBySessionId: text("created_by_session_id").notNull(),
		idempotencyDigest: text("idempotency_digest").notNull(),
		payloadDigest: text("payload_digest").notNull(),
		originalTediId: text("original_tedi_id"),
		originalRunId: text("original_run_id"),
		originalWorkId: text("original_work_id"),
		originalExecutionId: text("original_execution_id"),
		originalReservationId: text("original_reservation_id"),
		rateCertificateDigest: text("rate_certificate_digest"),
		reportedCostDecimal: text("reported_cost_decimal"),
		reportedReporter: text("reported_reporter"),
		supersedesEvidenceVersionId: text("supersedes_evidence_version_id"),
		originalSourceSnapshot: text("original_source_snapshot", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull(),
		deploymentScope: text("deployment_scope", { mode: "json" })
			.$type<Record<string, JsonValue>>()
			.notNull(),
		rateCertificateSnapshot: text("rate_certificate_snapshot", {
			mode: "json",
		}).$type<Record<string, JsonValue>>(),
		reportedEstimateSnapshot: text("reported_estimate_snapshot", {
			mode: "json",
		}).$type<Record<string, JsonValue>>(),
		financialManifestSnapshot: text("financial_manifest_snapshot", {
			mode: "json",
		})
			.$type<Record<string, JsonValue>>()
			.notNull(),
		approvalDecisionSnapshot: text("approval_decision_snapshot", {
			mode: "json",
		})
			.$type<Record<string, JsonValue>>()
			.notNull(),
		originalSourceVersion: integer("original_source_version").notNull(),
		inputTokens: integer("input_tokens").notNull(),
		outputTokens: integer("output_tokens").notNull(),
		cacheReadTokens: integer("cache_read_tokens").notNull(),
		cacheWriteTokens: integer("cache_write_tokens").notNull(),
		providerEstimatedCostMicros: integer(
			"provider_estimated_cost_micros",
		).notNull(),
		financialWorkVersion: integer("financial_work_version").notNull(),
		inputPriceMicrosPerMillion: integer("input_price_micros_per_million"),
		outputPriceMicrosPerMillion: integer("output_price_micros_per_million"),
		cacheReadPriceMicrosPerMillion: integer(
			"cache_read_price_micros_per_million",
		),
		cacheWritePriceMicrosPerMillion: integer(
			"cache_write_price_micros_per_million",
		),
		nativeUsageKnown: integer("native_usage_known", {
			mode: "boolean",
		}).notNull(),
		kind: text("kind", { enum: ["provider_estimate"] }).notNull(),
		currency: text("currency", { enum: ["USD"] }).notNull(),
		pricingBasis: text("pricing_basis", {
			enum: ["reported_estimate", "rate_estimated"],
		}).notNull(),
	},
	(table) => [
		check(
			"chk_provider_cost_evidence_known_safe",
			sql`${table.nativeUsageKnown} = 1
AND ${table.kind} = 'provider_estimate'
AND ${table.currency} = 'USD'
AND length(${table.originalOrgId}) > 0
AND length(${table.sourceGatewayId}) > 0
AND length(${table.gatewayLogId}) > 0
AND length(${table.sourceCallId}) > 0
AND length(${table.scopeDigest}) = 64
AND length(${table.basisFactsDigest}) = 64
AND typeof(${table.originalSourceVersion}) = 'integer' AND ${table.originalSourceVersion} BETWEEN 0 AND 9007199254740991
AND typeof(${table.inputTokens}) = 'integer' AND ${table.inputTokens} BETWEEN 0 AND 9007199254740991
AND typeof(${table.outputTokens}) = 'integer' AND ${table.outputTokens} BETWEEN 0 AND 9007199254740991
AND typeof(${table.cacheReadTokens}) = 'integer' AND ${table.cacheReadTokens} BETWEEN 0 AND 9007199254740991
AND typeof(${table.cacheWriteTokens}) = 'integer' AND ${table.cacheWriteTokens} BETWEEN 0 AND 9007199254740991
AND typeof(${table.providerEstimatedCostMicros}) = 'integer' AND ${table.providerEstimatedCostMicros} BETWEEN 0 AND 9007199254740991
AND typeof(${table.financialWorkVersion}) = 'integer' AND ${table.financialWorkVersion} BETWEEN 0 AND 9007199254740991
AND ${table.originalSourceVersion} >= 1
AND ${table.financialWorkVersion} >= 1
AND ${table.cacheReadTokens} <= ${table.inputTokens} - ${table.cacheWriteTokens}
AND ((${table.pricingBasis} = 'rate_estimated' AND ${table.rateCertificateDigest} IS NOT NULL AND ${table.rateCertificateSnapshot} IS NOT NULL AND ${table.inputPriceMicrosPerMillion} IS NOT NULL AND ${table.outputPriceMicrosPerMillion} IS NOT NULL AND ${table.cacheReadPriceMicrosPerMillion} IS NOT NULL AND ${table.cacheWritePriceMicrosPerMillion} IS NOT NULL AND typeof(${table.inputPriceMicrosPerMillion}) = 'integer' AND ${table.inputPriceMicrosPerMillion} BETWEEN 0 AND 9007199254740991 AND typeof(${table.outputPriceMicrosPerMillion}) = 'integer' AND ${table.outputPriceMicrosPerMillion} BETWEEN 0 AND 9007199254740991 AND typeof(${table.cacheReadPriceMicrosPerMillion}) = 'integer' AND ${table.cacheReadPriceMicrosPerMillion} BETWEEN 0 AND 9007199254740991 AND typeof(${table.cacheWritePriceMicrosPerMillion}) = 'integer' AND ${table.cacheWritePriceMicrosPerMillion} BETWEEN 0 AND 9007199254740991 AND json_valid(${table.rateCertificateSnapshot}) AND ${table.reportedEstimateSnapshot} IS NULL AND ${table.reportedCostDecimal} IS NULL AND ${table.reportedReporter} IS NULL) OR (${table.pricingBasis} = 'reported_estimate' AND ${table.rateCertificateDigest} IS NULL AND ${table.rateCertificateSnapshot} IS NULL AND ${table.inputPriceMicrosPerMillion} IS NULL AND ${table.outputPriceMicrosPerMillion} IS NULL AND ${table.cacheReadPriceMicrosPerMillion} IS NULL AND ${table.cacheWritePriceMicrosPerMillion} IS NULL AND ${table.reportedEstimateSnapshot} IS NOT NULL AND ${table.reportedCostDecimal} IS NOT NULL AND ${table.reportedReporter} IS NOT NULL AND ${table.reportedReporter} = 'cloudflare_ai_gateway' AND length(${table.reportedCostDecimal}) BETWEEN 1 AND 36 AND json_valid(${table.reportedEstimateSnapshot})))`,
		),
		uniqueIndex("uniq_provider_cost_evidence_original_root")
			.on(
				table.originalOrgId,
				table.sourceGatewayId,
				table.gatewayLogId,
				table.sourceCallId,
			)
			.where(sql`${table.supersedesEvidenceVersionId} IS NULL`),
		uniqueIndex("uniq_provider_cost_evidence_child")
			.on(table.supersedesEvidenceVersionId)
			.where(sql`${table.supersedesEvidenceVersionId} IS NOT NULL`),
		uniqueIndex("uniq_provider_cost_evidence_idempotency").on(
			table.idempotencyDigest,
		),
		index("idx_provider_cost_evidence_org_time_source").on(
			table.originalOrgId,
			table.occurredAt,
			table.sourceCallId,
		),
	],
);
