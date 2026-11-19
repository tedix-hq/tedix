import type { CoreStoreBinding } from "../postgres/core-store";
import type { PgQueryClient } from "../../pg/query-client";
import { and, desc, eq, gte, inArray, lt, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	billingUsageCharges,
	billingUsageReservations,
} from "../../schema/billing";
import { chunkForBoundParams } from "../../utils/batch";

/**
 * Settled EUR charges whose reservation belongs to one of `runIds`, summed.
 * Same receipt filter as the spending list: monetary EUR quotes only.
 */
export async function sumRunInferenceCharges(
	db: DbClient | CoreStoreBinding<PgQueryClient>,
	input: { organizationId: string; runIds: readonly string[] },
): Promise<{ chargedMicros: number; chargeCount: number }> {
	if ("plane" in db) {
		if (db.plane === "postgres")
			return (
				await import("../../pg/queries/billing/spending")
			).sumRunInferenceCharges(db.db, input);
		db = db.db;
	}

	let chargedMicros = 0;
	let chargeCount = 0;
	// One bound parameter for the organization plus the run ids per statement.
	for (const runIds of chunkForBoundParams([...new Set(input.runIds)], 90)) {
		const [row] = await db
			.select({
				// A call's worth is the included credit it used plus what was charged
				// beyond it, as Billing's settled spending shows it.
				chargedMicros: sql<number>`coalesce(sum(${billingUsageCharges.creditAppliedMicros} + ${billingUsageCharges.customerChargeMicros}), 0)`,
				chargeCount: sql<number>`count(${billingUsageCharges.id})`,
			})
			.from(billingUsageCharges)
			.innerJoin(
				billingUsageReservations,
				and(
					eq(billingUsageCharges.reservationId, billingUsageReservations.id),
					eq(
						billingUsageCharges.organizationId,
						billingUsageReservations.organizationId,
					),
				),
			)
			.where(
				and(
					eq(billingUsageCharges.organizationId, input.organizationId),
					inArray(billingUsageReservations.runId, runIds),
					sql`json_extract(${billingUsageCharges.metadata}, '$.monetaryQuote.schemaVersion') = 1`,
					sql`json_extract(${billingUsageCharges.metadata}, '$.monetaryQuote.rateSnapshot.customerCurrency') = 'EUR'`,
				),
			);
		chargedMicros += Number(row?.chargedMicros ?? 0);
		chargeCount += Number(row?.chargeCount ?? 0);
	}
	return { chargedMicros, chargeCount };
}

/**
 * Settled EUR charges per run id, for the runs in `runIds` that have at least
 * one. Same receipt filter as `sumRunInferenceCharges`.
 */
export async function sumRunInferenceChargesByRun(
	db: DbClient | CoreStoreBinding<PgQueryClient>,
	input: { organizationId: string; runIds: readonly string[] },
): Promise<Map<string, { chargedMicros: number; chargeCount: number }>> {
	if ("plane" in db) {
		if (db.plane === "postgres")
			return (
				await import("../../pg/queries/billing/spending")
			).sumRunInferenceChargesByRun(db.db, input);
		db = db.db;
	}

	const byRun = new Map<
		string,
		{ chargedMicros: number; chargeCount: number }
	>();
	for (const runIds of chunkForBoundParams([...new Set(input.runIds)], 90)) {
		const rows = await db
			.select({
				runId: billingUsageReservations.runId,
				chargedMicros: sql<number>`coalesce(sum(${billingUsageCharges.creditAppliedMicros} + ${billingUsageCharges.customerChargeMicros}), 0)`,
				chargeCount: sql<number>`count(${billingUsageCharges.id})`,
			})
			.from(billingUsageCharges)
			.innerJoin(
				billingUsageReservations,
				and(
					eq(billingUsageCharges.reservationId, billingUsageReservations.id),
					eq(
						billingUsageCharges.organizationId,
						billingUsageReservations.organizationId,
					),
				),
			)
			.where(
				and(
					eq(billingUsageCharges.organizationId, input.organizationId),
					inArray(billingUsageReservations.runId, runIds),
					sql`json_extract(${billingUsageCharges.metadata}, '$.monetaryQuote.schemaVersion') = 1`,
					sql`json_extract(${billingUsageCharges.metadata}, '$.monetaryQuote.rateSnapshot.customerCurrency') = 'EUR'`,
				),
			)
			.groupBy(billingUsageReservations.runId);
		for (const row of rows) {
			if (!row.runId) continue;
			byRun.set(row.runId, {
				chargedMicros: Number(row.chargedMicros ?? 0),
				chargeCount: Number(row.chargeCount ?? 0),
			});
		}
	}
	return byRun;
}
