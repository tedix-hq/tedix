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

export const billingPlanVersions = pgTable(
	"billing_plan_versions",
	{
		id: text("id").primaryKey(),
		planKey: text("plan_key").notNull(),
		version: integer("version").notNull(),
		status: text("status").notNull().default("draft"),
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
		overageUnitTokens: integer("overage_unit_tokens").notNull().default(1_000),
		overageUnitPriceMicros: micros("overage_unit_price_micros")
			.notNull()
			.default(0),
		maxTedis: integer("max_tedis").notNull(),
		maxCronJobsPerTedi: integer("max_cron_jobs_per_tedi").notNull(),
		maxIterationsPerTask: integer("max_iterations_per_task").notNull(),
		defaultDailyTokenLimit: integer("default_daily_token_limit").notNull(),
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
		status: text("status").notNull().default("trial"),
		billingMode: text("billing_mode").notNull().default("trial"),
		stripeEnvironment: text("stripe_environment"),
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
		kind: text("kind").notNull(),
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
		status: text("status").notNull().default("reserved"),
		source: text("source").notNull(),
		provider: text("provider").notNull(),
		model: text("model").notNull(),
		estimatedInputTokens: integer("estimated_input_tokens")
			.notNull()
			.default(0),
		estimatedOutputTokens: integer("estimated_output_tokens")
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
