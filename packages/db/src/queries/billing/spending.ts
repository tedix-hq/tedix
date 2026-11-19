import { and, eq, inArray, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	billingCreditConsumptions,
	billingUsageCharges,
	billingUsageReservations,
} from "../../schema/billing";
import { chunkForBoundParams } from "../../utils/batch";

export type RunCreditTotal = { credits: number; chargeCount: number };

/**
 * Tedix credits recorded for AI calls whose reservation belongs to one of
 * `runIds`, per run. An AI consumption's `source_ref` is its settled charge,
 * and the charge's reservation carries the run. Runs with no consumption are
 * left out: absent is never a known zero.
 */
export async function sumRunCreditsByRun(
	db: DbClient,
	input: { organizationId: string; runIds: readonly string[] },
): Promise<Map<string, RunCreditTotal>> {
	const byRun = new Map<string, RunCreditTotal>();
	// One bound parameter for the organization plus the run ids per statement.
	for (const runIds of chunkForBoundParams([...new Set(input.runIds)], 90)) {
		const rows = await db
			.select({
				runId: billingUsageReservations.runId,
				credits: sql<number>`coalesce(sum(${billingCreditConsumptions.credits}), 0)`,
				chargeCount: sql<number>`count(${billingCreditConsumptions.id})`,
			})
			.from(billingCreditConsumptions)
			.innerJoin(
				billingUsageCharges,
				and(
					eq(billingUsageCharges.id, billingCreditConsumptions.sourceRef),
					eq(
						billingUsageCharges.organizationId,
						billingCreditConsumptions.organizationId,
					),
				),
			)
			.innerJoin(
				billingUsageReservations,
				and(
					eq(billingUsageReservations.id, billingUsageCharges.reservationId),
					eq(
						billingUsageReservations.organizationId,
						billingUsageCharges.organizationId,
					),
				),
			)
			.where(
				and(
					eq(billingCreditConsumptions.organizationId, input.organizationId),
					eq(billingCreditConsumptions.kind, "ai"),
					inArray(billingUsageReservations.runId, runIds),
				),
			)
			.groupBy(billingUsageReservations.runId);
		for (const row of rows) {
			if (!row.runId) continue;
			byRun.set(row.runId, {
				credits: Number(row.credits ?? 0),
				chargeCount: Number(row.chargeCount ?? 0),
			});
		}
	}
	return byRun;
}

/** Tedix credits recorded for AI calls of all `runIds`, summed. */
export async function sumRunCredits(
	db: DbClient,
	input: { organizationId: string; runIds: readonly string[] },
): Promise<RunCreditTotal> {
	let credits = 0;
	let chargeCount = 0;
	for (const total of (await sumRunCreditsByRun(db, input)).values()) {
		credits += total.credits;
		chargeCount += total.chargeCount;
	}
	return { credits, chargeCount };
}
