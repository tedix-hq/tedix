import type { GatewayChangeRecordInput } from "@tedix/api-contract/schemas/audit";
import { and, asc, eq, gt } from "drizzle-orm";
import type { DbQueryClient } from "../query-client";
import { gatewayChangeRecords } from "../schema/gateway-change-records";

function toRecord(row: typeof gatewayChangeRecords.$inferSelect) {
	return {
		...row.record,
		id: row.id,
		sequence: row.sequence,
		recordedAt: row.recordedAt,
	};
}

/**
 * Append one record. A record whose `id` this organization already stored is
 * returned as stored and nothing is written; the lookup runs only then.
 */
export async function appendGatewayChangeRecord(
	db: DbQueryClient,
	organizationId: string,
	input: GatewayChangeRecordInput,
) {
	const { id = crypto.randomUUID(), recordedAt, ...record } = input;
	const [row] = await db
		.insert(gatewayChangeRecords)
		.values({
			id,
			organizationId,
			resource: record.resource,
			actorId: record.actor.id,
			recordedAt: recordedAt ?? new Date().toISOString(),
			record,
		})
		.onConflictDoNothing({ target: gatewayChangeRecords.id })
		.returning();
	if (row) return toRecord(row);
	const stored = await getGatewayChangeRecord(db, organizationId, id);
	if (!stored) throw new Error("Gateway change record was not stored");
	return stored;
}

export async function listGatewayChangeRecords(
	db: DbQueryClient,
	organizationId: string,
	query: {
		resource?: string;
		actorId?: string;
		afterSequence?: number;
		limit?: number;
	},
) {
	const rows = await db
		.select()
		.from(gatewayChangeRecords)
		.where(
			and(
				eq(gatewayChangeRecords.organizationId, organizationId),
				query.resource === undefined
					? undefined
					: eq(gatewayChangeRecords.resource, query.resource),
				query.actorId === undefined
					? undefined
					: eq(gatewayChangeRecords.actorId, query.actorId),
				query.afterSequence === undefined
					? undefined
					: gt(gatewayChangeRecords.sequence, query.afterSequence),
			),
		)
		.orderBy(asc(gatewayChangeRecords.sequence))
		.limit(query.limit ?? 1000);
	return rows.map(toRecord);
}

export async function getGatewayChangeRecord(
	db: DbQueryClient,
	organizationId: string,
	id: string,
) {
	const [row] = await db
		.select()
		.from(gatewayChangeRecords)
		.where(
			and(
				eq(gatewayChangeRecords.organizationId, organizationId),
				eq(gatewayChangeRecords.id, id),
			),
		)
		.limit(1);
	return row ? toRecord(row) : null;
}
