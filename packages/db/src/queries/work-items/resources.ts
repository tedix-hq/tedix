import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import { workAttempts, workItems } from "../../schema/work-items";
import type { DbQueryClient } from "../../query-client";
import { chunkForBoundParams } from "../../utils/batch";
import {
	workResourcePools,
	workResourceReservations,
	type WorkResourcePool,
} from "../../schema/work-factory";
import { WorkControlError } from "./factory-validation";

export interface CreateWorkResourcePoolParams {
	id: string;
	orgId: string;
	resourceKey: string;
	allocationMode: "exclusive" | "capacity";
	capacity: number;
	ownerRef?: string | null;
	metadata?: Record<string, JsonValue>;
	now: string;
}
export async function createWorkResourcePool(
	db: DbQueryClient,
	p: CreateWorkResourcePoolParams,
): Promise<WorkResourcePool> {
	return (
		await db
			.insert(workResourcePools)
			.values({
				...p,
				enabled: true,
				metadata: p.metadata ?? {},
				createdAt: p.now,
				updatedAt: null,
				version: 1,
			})
			.returning()
	)[0]!;
}
export async function updateWorkResourcePool(
	db: DbQueryClient,
	p: {
		orgId: string;
		poolId: string;
		expectedVersion: number;
		allocationMode?: "exclusive" | "capacity";
		capacity?: number;
		ownerRef?: string | null;
		enabled?: boolean;
		metadata?: Record<string, JsonValue>;
		now: string;
	},
) {
	const row = (
		await db
			.update(workResourcePools)
			.set({
				allocationMode: p.allocationMode,
				capacity: p.capacity,
				ownerRef: p.ownerRef,
				enabled: p.enabled,
				metadata: p.metadata,
				updatedAt: p.now,
				version: sql`${workResourcePools.version}+1`,
			})
			.where(
				and(
					eq(workResourcePools.orgId, p.orgId),
					eq(workResourcePools.id, p.poolId),
					eq(workResourcePools.version, p.expectedVersion),
					p.capacity !== undefined
						? sql`${p.capacity}>=(SELECT COALESCE(SUM(${workResourceReservations.quantity}),0) FROM ${workResourceReservations} WHERE ${workResourceReservations.orgId}=${p.orgId} AND ${workResourceReservations.poolId}=${p.poolId} AND ${workResourceReservations.state}='active' AND ${workResourceReservations.expiresAt}>${p.now})`
						: undefined,
				),
			)
			.returning()
	)[0];
	if (!row)
		throw new WorkControlError(
			"CONFLICT",
			"Resource pool changed or capacity is below active reservations",
		);
	return row;
}
export async function getWorkResourcePoolByKey(
	db: DbQueryClient,
	p: { orgId: string; resourceKey: string; includeDisabled?: boolean },
) {
	return (
		(
			await db
				.select()
				.from(workResourcePools)
				.where(
					and(
						eq(workResourcePools.orgId, p.orgId),
						eq(workResourcePools.resourceKey, p.resourceKey),
						p.includeDisabled ? undefined : eq(workResourcePools.enabled, true),
					),
				)
				.limit(1)
		)[0] ?? null
	);
}
export async function listWorkResourcePools(
	db: DbQueryClient,
	p: {
		orgId: string;
		resourceKey?: string;
		saturatedOnly?: boolean;
		includeDisabled?: boolean;
		at: string;
		cursor?: string;
		limit?: number;
	},
) {
	const limit = Math.min(p.limit ?? 100, 500);
	const rows = await db
		.select({
			pool: workResourcePools,
			// Explicit outer qualifiers survive Drizzle's single-table column rewriting.
			activeReserved:
				sql<number>`COALESCE((SELECT SUM(r.quantity) FROM work_resource_reservations r WHERE r.org_id="work_resource_pools"."org_id" AND r.pool_id="work_resource_pools"."id" AND r.state='active' AND r.expires_at>${p.at}),0)`.as(
					"active_reserved",
				),
		})
		.from(workResourcePools)
		.where(
			and(
				eq(workResourcePools.orgId, p.orgId),
				p.resourceKey !== undefined
					? eq(workResourcePools.resourceKey, p.resourceKey)
					: undefined,
				p.includeDisabled ? undefined : eq(workResourcePools.enabled, true),
				p.saturatedOnly
					? sql`COALESCE((SELECT SUM(r.quantity) FROM work_resource_reservations r WHERE r.org_id="work_resource_pools"."org_id" AND r.pool_id="work_resource_pools"."id" AND r.state='active' AND r.expires_at>${p.at}),0) >= ${workResourcePools.capacity}`
					: undefined,
				p.cursor ? gt(workResourcePools.id, p.cursor) : undefined,
			),
		)
		.orderBy(asc(workResourcePools.id))
		.limit(limit + 1);
	const hasMore = rows.length > limit;
	const page = rows.slice(0, limit).map((row) => ({
		...row,
		effectiveAvailable: Math.max(0, row.pool.capacity - row.activeReserved),
	}));
	return {
		data: page,
		nextCursor: hasMore ? page.at(-1)!.pool.id : null,
		observedAt: p.at,
	};
}

/** One bounded query for the current page, retaining one overflow row per pool. */
export async function listActiveWorkResourceHolders(
	db: DbQueryClient,
	p: { orgId: string; poolIds: string[]; at: string },
) {
	if (p.poolIds.length === 0) return [];
	const readChunk = async (poolIds: string[]) => {
		const ranked = db
			.select({
				poolId: workResourceReservations.poolId,
				reservationId: sql<string>`${workResourceReservations.id}`.as(
					"reservation_id",
				),
				quantity: workResourceReservations.quantity,
				expiresAt: workResourceReservations.expiresAt,
				attemptId: sql<string>`${workAttempts.id}`.as("holder_attempt_id"),
				workItemId: sql<string>`${workItems.id}`.as("holder_work_item_id"),
				workTitle: workItems.title,
				executorType: workAttempts.executorType,
				executorId: workAttempts.executorId,
				externalSessionKey: workAttempts.externalSessionKey,
				holderRank:
					sql<number>`ROW_NUMBER() OVER (PARTITION BY ${workResourceReservations.poolId} ORDER BY ${workResourceReservations.id})`.as(
						"holder_rank",
					),
			})
			.from(workResourceReservations)
			.innerJoin(
				workAttempts,
				and(
					eq(workAttempts.orgId, p.orgId),
					eq(workAttempts.workItemId, workResourceReservations.workItemId),
					eq(workAttempts.admissionId, workResourceReservations.admissionId),
				),
			)
			.innerJoin(
				workItems,
				and(
					eq(workItems.orgId, p.orgId),
					eq(workItems.id, workResourceReservations.workItemId),
				),
			)
			.where(
				and(
					eq(workResourceReservations.orgId, p.orgId),
					// bound-params: readChunk receives at most 50 pool IDs from chunkForBoundParams below.
					inArray(workResourceReservations.poolId, poolIds),
					eq(workResourceReservations.state, "active"),
					gt(workResourceReservations.expiresAt, p.at),
				),
			);
		const page = ranked.as("ranked_resource_holders");
		return db
			.select()
			.from(page)
			.where(lte(page.holderRank, 9))
			.orderBy(asc(page.poolId), asc(page.reservationId));
	};
	return (
		await Promise.all(chunkForBoundParams(p.poolIds, 50).map(readChunk))
	).flat();
}
