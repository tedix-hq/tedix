import { sql } from "drizzle-orm";
import {
	index,
	integer,
	sqliteTable,
	text,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Per-row verdict of the daily ledger-vs-AI-Gateway comparison.
 * - `matched`: missing charges fall within the reconciliation thresholds.
 * - `drift`: missing charges exceed a threshold and some calls have charges.
 * - `gateway_only`: missing charges exceed a threshold and no calls have charges.
 * - `ledger_only`: retained for historical cost comparisons.
 */
export const BILLING_GATEWAY_RECONCILIATION_STATUSES = [
	"matched",
	"drift",
	"ledger_only",
	"gateway_only",
] as const;
export type BillingGatewayReconciliationStatus =
	(typeof BILLING_GATEWAY_RECONCILIATION_STATUSES)[number];

export interface GatewayReconciliationCoverage {
	missingCallCount: number;
	/** Gateway-reported cost estimate for missing calls, not a customer charge. */
	missingCostMicros: number;
	missingUnpricedCallCount: number;
	tokenCheckedCallCount: number;
	tokenMismatchCallCount: number;
	tokenUnknownCallCount: number;
	platformOverheadCallCount: number;
	platformOverheadCostMicros: number;
}

/**
 * Daily comparison of our cost ledger (`billing_usage_charges`) with
 * Cloudflare AI Gateway logs for one gateway. One row per closed UTC day,
 * provider and normalized model; `model = ''` is the provider-day total.
 *
 * This is evidence only. It does not reconcile charges, change customer
 * billing, or feed `billing_provider_reconciliations` (which holds billed
 * provider invoices, not Gateway analytics).
 */
export const billingGatewayReconciliations = sqliteTable(
	"billing_gateway_reconciliations",
	{
		id: text("id").primaryKey(),
		/** UTC calendar day, `YYYY-MM-DD`. */
		day: text("day").notNull(),
		gatewayId: text("gateway_id").notNull(),
		provider: text("provider").notNull(),
		/** Normalized model; empty string is the provider-day total. */
		model: text("model").notNull().default(""),
		ledgerCostMicros: integer("ledger_cost_micros").notNull(),
		gatewayCostMicros: integer("gateway_cost_micros").notNull(),
		/** `ledger_cost_micros - gateway_cost_micros`. */
		differenceMicros: integer("difference_micros").notNull(),
		ledgerRowCount: integer("ledger_row_count").notNull().default(0),
		gatewayRequestCount: integer("gateway_request_count").notNull().default(0),
		/** Null on historical rows that compared raw dollar totals. */
		coverage: text("coverage", {
			mode: "json",
		}).$type<GatewayReconciliationCoverage>(),
		status: text("status", {
			enum: BILLING_GATEWAY_RECONCILIATION_STATUSES,
		}).notNull(),
		computedAt: text("computed_at")
			.notNull()
			.default(sql`(CURRENT_TIMESTAMP)`),
	},
	(table) => [
		uniqueIndex("uniq_billing_gateway_reconciliation").on(
			table.day,
			table.gatewayId,
			table.provider,
			table.model,
		),
		index("idx_billing_gateway_reconciliation_status").on(
			table.status,
			table.day,
		),
	],
);

export type BillingGatewayReconciliationRow =
	typeof billingGatewayReconciliations.$inferSelect;
export type NewBillingGatewayReconciliationRow =
	typeof billingGatewayReconciliations.$inferInsert;
