import { and, asc, gte, lte } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { coreTable } from "../../core-store/client";
import { billingCloudflareDailyCosts as schemaCosts } from "../../schema/billing";

export type CloudflareDailyCost = typeof schemaCosts.$inferSelect;

export async function upsertCloudflareDailyCost(
	db: DbQueryClient,
	row: CloudflareDailyCost,
) {
	const costs = coreTable(db, schemaCosts);
	await db
		.insert(costs)
		.values(row)
		.onConflictDoUpdate({
			target: [costs.accountId, costs.service, costs.day],
			set: {
				costMicros: row.costMicros,
				consumedQuantity: row.consumedQuantity,
				consumedUnit: row.consumedUnit,
				fetchedAt: row.fetchedAt,
			},
		});
}

export async function listCloudflareDailyCosts(
	db: DbQueryClient,
	from: string,
	to: string,
) {
	const costs = coreTable(db, schemaCosts);
	return db
		.select()
		.from(costs)
		.where(and(gte(costs.day, from), lte(costs.day, to)))
		.orderBy(asc(costs.day), asc(costs.service));
}

/** Compare a closed day with the preceding seven calendar days, excluding itself.
 * Missing days are not zero evidence: require seven observations for a service.
 */
export function cloudflareCostJumps(rows: CloudflareDailyCost[], day: string) {
	const start = new Date(`${day}T00:00:00Z`);
	start.setUTCDate(start.getUTCDate() - 7);
	const from = start.toISOString().slice(0, 10);
	return rows
		.filter((row) => row.day === day && row.costMicros > 10_000_000)
		.flatMap((row) => {
			const previous = rows.filter(
				(prior) =>
					prior.accountId === row.accountId &&
					prior.service === row.service &&
					prior.day >= from &&
					prior.day < day,
			);
			if (new Set(previous.map((prior) => prior.day)).size !== 7) return [];
			const averageMicros =
				previous.reduce((sum, prior) => sum + prior.costMicros, 0) / 7;
			return row.costMicros > 2 * averageMicros
				? [{ ...row, averageMicros }]
				: [];
		});
}
