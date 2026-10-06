import { and, asc, eq, inArray, isNotNull, isNull, lt } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	billingProviderUsage,
	billingUsageCharges,
	billingUsageQuarantines,
} from "../schema/billing";
import { organizations } from "../schema/organizations";
import {
	gatewayLogIngestionCursors,
	type NewGatewayLogIngestionCursor,
	type TediCallCost,
	tediCallCosts,
	tedis,
} from "../schema/tedis";
import { chunkForBoundParams } from "../utils/batch";

export async function listUnsettledBillableGatewayCalls(
	db: DbClient,
	limit: number,
): Promise<TediCallCost[]> {
	const rows = await db
		.select({ call: tediCallCosts })
		.from(tediCallCosts)
		.leftJoin(
			billingUsageCharges,
			eq(billingUsageCharges.gatewayLogId, tediCallCosts.gatewayLogId),
		)
		.leftJoin(
			billingUsageQuarantines,
			eq(billingUsageQuarantines.gatewayLogId, tediCallCosts.gatewayLogId),
		)
		.where(
			and(
				isNotNull(tediCallCosts.orgId),
				isNotNull(tediCallCosts.billingReservationId),
				isNull(tediCallCosts.usageKind),
				eq(tediCallCosts.success, true),
				isNull(billingUsageCharges.id),
				isNull(billingUsageQuarantines.id),
			),
		)
		.orderBy(asc(tediCallCosts.snapshotAt), asc(tediCallCosts.gatewayLogId))
		.limit(limit);
	return rows.map(({ call }) => call);
}

export async function listUnrecordedProviderUsageCalls(
	db: DbClient,
	limit: number,
): Promise<TediCallCost[]> {
	const rows = await db
		.select({ call: tediCallCosts })
		.from(tediCallCosts)
		.leftJoin(
			billingProviderUsage,
			eq(billingProviderUsage.gatewayLogId, tediCallCosts.gatewayLogId),
		)
		.leftJoin(
			billingUsageQuarantines,
			eq(billingUsageQuarantines.gatewayLogId, tediCallCosts.gatewayLogId),
		)
		.where(
			and(
				eq(tediCallCosts.success, true),
				isNotNull(tediCallCosts.usageKind),
				isNotNull(tediCallCosts.usageUnit),
				isNotNull(tediCallCosts.usageQuantity),
				isNull(billingProviderUsage.id),
				isNull(billingUsageQuarantines.id),
			),
		)
		.orderBy(asc(tediCallCosts.snapshotAt), asc(tediCallCosts.gatewayLogId))
		.limit(limit);
	return rows.map(({ call }) => call);
}

export async function listLegacyUnreservedGatewayCalls(
	db: DbClient,
	limit: number,
): Promise<TediCallCost[]> {
	const rows = await db
		.select({ call: tediCallCosts })
		.from(tediCallCosts)
		.leftJoin(
			billingUsageCharges,
			eq(billingUsageCharges.gatewayLogId, tediCallCosts.gatewayLogId),
		)
		.leftJoin(
			billingUsageQuarantines,
			eq(billingUsageQuarantines.gatewayLogId, tediCallCosts.gatewayLogId),
		)
		.where(
			and(
				isNotNull(tediCallCosts.orgId),
				isNull(tediCallCosts.billingReservationId),
				isNull(tediCallCosts.usageKind),
				eq(tediCallCosts.success, true),
				isNull(billingUsageCharges.id),
				isNull(billingUsageQuarantines.id),
			),
		)
		.orderBy(asc(tediCallCosts.snapshotAt), asc(tediCallCosts.gatewayLogId))
		.limit(limit);
	return rows.map(({ call }) => call);
}

export async function loadKnownGatewayAttributionIds(
	db: DbClient,
	input: { organizationIds: string[]; tediIds: string[] },
): Promise<{ organizationIds: string[]; tediIds: string[] }> {
	// D1 caps bound parameters at 100 per statement; chunk each IN() list.
	const organizationRows: Array<{ id: string }> = [];
	for (const chunk of chunkForBoundParams(
		[...new Set(input.organizationIds)],
		50,
	)) {
		organizationRows.push(
			...(await db
				.select({ id: organizations.id })
				.from(organizations)
				.where(inArray(organizations.id, chunk))),
		);
	}
	const tediRows: Array<{ id: string }> = [];
	for (const chunk of chunkForBoundParams([...new Set(input.tediIds)], 50)) {
		tediRows.push(
			...(await db
				.select({ id: tedis.id })
				.from(tedis)
				.where(inArray(tedis.id, chunk))),
		);
	}
	return {
		organizationIds: organizationRows.map(({ id }) => id),
		tediIds: tediRows.map(({ id }) => id),
	};
}

export async function getGatewayLogIngestionCursor(
	db: DbClient,
	gatewayId: string,
) {
	const [row] = await db
		.select()
		.from(gatewayLogIngestionCursors)
		.where(eq(gatewayLogIngestionCursors.gatewayId, gatewayId))
		.limit(1);
	return row ?? null;
}

/**
 * Advance only from the exact cursor observed before the page was fetched.
 * Two cron fires may ingest the same rows, but only one can acknowledge them;
 * the loser must re-read rather than page on a stale provider offset.
 */
export async function advanceGatewayLogIngestionCursor(
	db: DbClient,
	input: Required<
		Pick<
			NewGatewayLogIngestionCursor,
			"gatewayId" | "lastLogCreatedAt" | "lastLogId" | "updatedAt"
		>
	> & {
		expected: Pick<
			NewGatewayLogIngestionCursor,
			"lastLogCreatedAt" | "lastLogId"
		> | null;
	},
): Promise<boolean> {
	if (
		input.expected &&
		input.lastLogCreatedAt <= input.expected.lastLogCreatedAt
	)
		return false;
	if (!input.expected) {
		const rows = await db
			.insert(gatewayLogIngestionCursors)
			.values({
				gatewayId: input.gatewayId,
				lastLogCreatedAt: input.lastLogCreatedAt,
				lastLogId: input.lastLogId,
				updatedAt: input.updatedAt,
			})
			.onConflictDoNothing({ target: gatewayLogIngestionCursors.gatewayId })
			.returning({ gatewayId: gatewayLogIngestionCursors.gatewayId });
		return rows.length === 1;
	}
	const rows = await db
		.update(gatewayLogIngestionCursors)
		.set({
			lastLogCreatedAt: input.lastLogCreatedAt,
			lastLogId: input.lastLogId,
			updatedAt: input.updatedAt,
		})
		.where(
			and(
				eq(gatewayLogIngestionCursors.gatewayId, input.gatewayId),
				eq(
					gatewayLogIngestionCursors.lastLogCreatedAt,
					input.expected.lastLogCreatedAt,
				),
				eq(gatewayLogIngestionCursors.lastLogId, input.expected.lastLogId),
				lt(gatewayLogIngestionCursors.lastLogCreatedAt, input.lastLogCreatedAt),
			),
		)
		.returning({ gatewayId: gatewayLogIngestionCursors.gatewayId });
	return rows.length === 1;
}
