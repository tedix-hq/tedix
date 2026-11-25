/** Daily ledger-vs-AI-Gateway cost reconciliation rows. */

import { and, asc, eq, gte, lt, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { anyIds, jsonRead } from "../../core-store/dialect";
import { billingUsageCharges as schemaBillingUsageCharges } from "../../schema/billing";
import {
	type BillingGatewayReconciliationRow,
	type NewBillingGatewayReconciliationRow,
	billingGatewayReconciliations as schemaBillingGatewayReconciliations,
} from "../../schema/billing-gateway-reconciliations";
import { chunkForBoundParams } from "../../utils/batch";

export interface LedgerCostByProviderModelParams {
	gatewayId: string;
	sinceInclusive: string;
	untilExclusive: string;
}

export interface LedgerCostByProviderModelResult {
	provider: string;
	/** Raw ledger model; callers normalize it before comparing. */
	model: string;
	costMicros: number;
	rowCount: number;
}

/**
 * Ledger provider cost for one gateway and window, grouped by provider and raw
 * model. Rows with no recorded `gatewayId` are included so cost that never
 * names a gateway remains visible in the informational ledger totals.
 */
export async function sumLedgerCostByProviderModel(
	db: DbQueryClient,
	params: LedgerCostByProviderModelParams,
): Promise<LedgerCostByProviderModelResult[]> {
	const billingUsageCharges = coreTable(db, schemaBillingUsageCharges);
	const rows = await db
		.select({
			provider: billingUsageCharges.provider,
			model: billingUsageCharges.model,
			costMicros:
				sql<number>`COALESCE(SUM(${billingUsageCharges.providerCostMicros}), 0)`.as(
					"cost_micros",
				),
			rowCount: sql<number>`COUNT(*)`.as("row_count"),
		})
		.from(billingUsageCharges)
		.where(
			and(
				gte(billingUsageCharges.occurredAt, params.sinceInclusive),
				lt(billingUsageCharges.occurredAt, params.untilExclusive),
				sql`COALESCE(${jsonRead(db, billingUsageCharges.metadata, ["gatewayId"])}, ${params.gatewayId}) = ${params.gatewayId}`,
			),
		)
		.groupBy(billingUsageCharges.provider, billingUsageCharges.model);
	return rows.map((row) => ({
		provider: row.provider,
		model: row.model,
		costMicros: Number(row.costMicros ?? 0),
		rowCount: Number(row.rowCount ?? 0),
	}));
}

/** Match IDs across settlement days; delayed charges must not look missing. */
export async function getGatewayLedgerCharges(
	db: DbQueryClient,
	params: { gatewayId: string; gatewayLogIds: string[] },
) {
	const billingUsageCharges = coreTable(db, schemaBillingUsageCharges);
	const rows = [];
	for (const ids of chunkForBoundParams(params.gatewayLogIds, 50)) {
		rows.push(
			...(await db
				.select({
					gatewayLogId: billingUsageCharges.gatewayLogId,
					inputTokens: billingUsageCharges.inputTokens,
					outputTokens: billingUsageCharges.outputTokens,
				})
				.from(billingUsageCharges)
				.where(
					and(
						anyIds(db, billingUsageCharges.gatewayLogId, ids),
						sql`COALESCE(${jsonRead(db, billingUsageCharges.metadata, ["gatewayId"])}, ${params.gatewayId}) = ${params.gatewayId}`,
					),
				)),
		);
	}
	return rows;
}

/** D1 binds at most 100 parameters per statement; a row binds up to 13. */
const INSERT_CHUNK_ROWS = 7;

export interface ReplaceGatewayReconciliationDayParams {
	day: string;
	gatewayId: string;
	rows: NewBillingGatewayReconciliationRow[];
}

/**
 * Replace one gateway-day atomically, so a re-run drops models that no longer
 * appear on either side instead of leaving stale rows behind.
 */
export async function replaceGatewayReconciliationDay(
	db: DbQueryClient,
	params: ReplaceGatewayReconciliationDayParams,
): Promise<void> {
	for (const row of params.rows) {
		if (row.day !== params.day || row.gatewayId !== params.gatewayId)
			throw new Error("Reconciliation row does not belong to the replaced day");
	}
	const billingGatewayReconciliations = coreTable(
		db,
		schemaBillingGatewayReconciliations,
	);
	const remove = db
		.delete(billingGatewayReconciliations)
		.where(
			and(
				eq(billingGatewayReconciliations.day, params.day),
				eq(billingGatewayReconciliations.gatewayId, params.gatewayId),
			),
		);
	const inserts = chunkForBoundParams(params.rows, INSERT_CHUNK_ROWS).map(
		(chunk) => db.insert(billingGatewayReconciliations).values(chunk),
	);
	await db.batch([remove, ...inserts]);
}

/** Rows of the most recent reconciled day, provider totals first. */
export async function getLatestGatewayReconciliation(
	db: DbQueryClient,
): Promise<BillingGatewayReconciliationRow[]> {
	const billingGatewayReconciliations = coreTable(
		db,
		schemaBillingGatewayReconciliations,
	);
	return db
		.select()
		.from(billingGatewayReconciliations)
		.where(
			eq(
				billingGatewayReconciliations.day,
				sql`(SELECT MAX(${billingGatewayReconciliations.day}) FROM ${billingGatewayReconciliations})`,
			),
		)
		.orderBy(
			asc(billingGatewayReconciliations.gatewayId),
			asc(billingGatewayReconciliations.provider),
			asc(billingGatewayReconciliations.model),
		);
}
