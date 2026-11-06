import { and, asc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import { workInteractions } from "../../schema/work-factory";
import { workItemComments, workItems } from "../../schema/work-items";

/** Metadata source of the request a lane raises when Work needs an owner's permission. */
export const LANE_DELEGATION_SOURCE = "lane-dispatch-blocker";

const laneRequest = sql`json_extract(${workInteractions.metadata},'$.source')=${LANE_DELEGATION_SOURCE}`;

/**
 * The ask is gone when its Work finished, its Work version moved on, or the
 * Work is no longer assigned to the lane that asked. Allow is fenced on the
 * same facts, so retiring such a card removes no authority.
 */
const askMoved = sql`NOT EXISTS (SELECT 1 FROM ${workItems}
	WHERE ${workItems.orgId}=${workInteractions.orgId}
	AND ${workItems.id}=${workInteractions.workItemId}
	AND ${workItems.disposition}='accepted'
	AND ${workItems.version}=json_extract(${workInteractions.metadata},'$.laneBlocker.workVersion')
	AND coalesce(json_extract(${workItems.metadata},'$.executor'),'')=coalesce(json_extract(${workInteractions.metadata},'$.laneBlocker.executor'),''))`;

/** The owner already posted this version's delegation, for example by hand. */
const delegated = sql`EXISTS (SELECT 1 FROM ${workItemComments}
	JOIN ${workItems} ON ${workItems.orgId}=${workItemComments.orgId} AND ${workItems.id}=${workItemComments.workItemId}
	WHERE ${workItemComments.orgId}=${workInteractions.orgId}
	AND ${workItemComments.workItemId}=${workInteractions.workItemId}
	AND ${workItemComments.authorType}='user'
	AND ${workItemComments.authorId}=${workItems.accountableOwnerId}
	AND (char(10) || ${workItemComments.body}) LIKE ('%' || char(10) || 'Delegation: ' || json_extract(${workInteractions.metadata},'$.laneBlocker.executor') || ' work-version=' || json_extract(${workInteractions.metadata},'$.laneBlocker.workVersion') || ' %'))`;

/** An older card already asks, or was answered by, the same person about the same version. */
const duplicate = sql`EXISTS (SELECT 1 FROM work_interactions older
	WHERE older.org_id=${workInteractions.orgId}
	AND older.work_item_id=${workInteractions.workItemId}
	AND older.status IN ('open','resolved')
	AND json_extract(older.metadata,'$.source')=${LANE_DELEGATION_SOURCE}
	AND json_extract(older.metadata,'$.laneBlocker.workVersion') IS json_extract(${workInteractions.metadata},'$.laneBlocker.workVersion')
	AND older.target_type IS ${workInteractions.targetType}
	AND older.target_id IS ${workInteractions.targetId}
	AND (older.created_at < ${workInteractions.createdAt} OR (older.created_at = ${workInteractions.createdAt} AND older.id < ${workInteractions.id})))`;

const superseded = sql`(${askMoved} OR ${delegated} OR ${duplicate})`;

function retire(now: string) {
	return {
		status: "cancelled" as const,
		cancelledAt: now,
		resolutionFence: crypto.randomUUID(),
		version: sql`${workInteractions.version}+1`,
	};
}

/**
 * One permission card per Work, version and person, whichever lane,
 * machine or login asks. Retires the Work's open cards whose ask moved on and
 * returns the open or answered card for the same ask, if one exists: an
 * answer, including No, is not asked again for the same version.
 */
export async function settleLaneDelegationRequests(
	db: DbQueryClient,
	p: {
		orgId: string;
		workItemId: string;
		workVersion: number;
		targetType: string;
		targetId: string;
		now: string;
	},
) {
	const sameWork = and(
		eq(workInteractions.orgId, p.orgId),
		eq(workInteractions.workItemId, p.workItemId),
		laneRequest,
	);
	const [retired, [existing]] = await db.batch([
		db
			.update(workInteractions)
			.set(retire(p.now))
			.where(
				and(
					sameWork,
					eq(workInteractions.status, "open"),
					sql`(${superseded} OR json_extract(${workInteractions.metadata},'$.laneBlocker.workVersion') IS NOT ${p.workVersion})`,
				),
			)
			.returning({ id: workInteractions.id }),
		db
			.select()
			.from(workInteractions)
			.where(
				and(
					sameWork,
					sql`${workInteractions.status} IN ('open','resolved')`,
					sql`json_extract(${workInteractions.metadata},'$.laneBlocker.workVersion')=${p.workVersion}`,
					sql`${workInteractions.targetType}=${p.targetType}`,
					eq(workInteractions.targetId, p.targetId),
				),
			)
			.orderBy(
				sql`${workInteractions.status}='open' DESC`,
				asc(workInteractions.createdAt),
				asc(workInteractions.id),
			)
			.limit(1),
	]);
	return { retired: retired.length, existing: existing ?? null };
}

/** Bounded sweep: retire open permission cards whose ask moved on, in one organization or all. */
export async function retireStaleLaneDelegationRequests(
	db: DbQueryClient,
	p: { orgId?: string; now: string; limit?: number },
) {
	const scope = p.orgId ? eq(workInteractions.orgId, p.orgId) : undefined;
	const stale = db
		.select({ id: workInteractions.id })
		.from(workInteractions)
		.where(
			and(scope, eq(workInteractions.status, "open"), laneRequest, superseded),
		)
		.limit(Math.min(200, Math.max(1, p.limit ?? 100)));
	const rows = await db
		.update(workInteractions)
		.set(retire(p.now))
		.where(
			and(
				scope,
				eq(workInteractions.status, "open"),
				sql`${workInteractions.id} IN ${stale}`,
			),
		)
		.returning({ id: workInteractions.id });
	return rows.length;
}
