import {
	and,
	asc,
	eq,
	getColumns,
	sql,
	type SQL,
	type SQLWrapper,
} from "drizzle-orm";
import { coreTable } from "../../core-store/client";
import { coreStore, jsonRead } from "../../core-store/dialect";
import type { DbQueryClient } from "../../query-client";
import {
	workInteractions as d1WorkInteractions,
	workInteractionStoredColumns,
} from "../../schema/work-factory";
import {
	workItemComments as d1WorkItemComments,
	workItems as d1WorkItems,
} from "../../schema/work-items";

/** Metadata source of the request a lane raises when Work needs an owner's permission. */
export const LANE_DELEGATION_SOURCE = "lane-dispatch-blocker";

/** Null-safe equality: SQLite IS, Postgres IS NOT DISTINCT FROM. */
function same(db: object, left: SQLWrapper, right: SQLWrapper): SQL {
	return coreStore(db) === "postgres"
		? sql`(${left} IS NOT DISTINCT FROM ${right})`
		: sql`(${left} IS ${right})`;
}

function laneSql(db: DbQueryClient) {
	const workInteractions = coreTable(db, d1WorkInteractions);
	const workItems = coreTable(db, d1WorkItems);
	const workItemComments = coreTable(db, d1WorkItemComments);
	// Parenthesized: Postgres parses `'a' || x #>> path` as `('a' || x) #>> path`.
	const blocker = (column: SQLWrapper, field: string, kind?: "number") =>
		sql`(${jsonRead(db, column, ["laneBlocker", field], kind)})`;
	const meta = workInteractions.metadata;
	const older = sql`older.metadata`;
	const newline = coreStore(db) === "postgres" ? sql`chr(10)` : sql`char(10)`;
	const isCheck = (column: SQLWrapper) =>
		sql`(coalesce(${blocker(column, "kind")}, '') = 'verification_check')`;
	/**
	 * The ask is gone when its Work finished, its Work version moved on, or the
	 * Work is no longer assigned to the lane that asked. Allow is fenced on the
	 * same facts, so retiring such a card removes no authority.
	 */
	const askMoved = sql`NOT EXISTS (SELECT 1 FROM ${workItems}
	WHERE ${workItems.orgId}=${workInteractions.orgId}
	AND ${workItems.id}=${workInteractions.workItemId}
	AND ${workItems.disposition}='accepted'
	AND ${workItems.version}=${blocker(meta, "workVersion", "number")}
	AND coalesce(${workItems.executorId},'')=coalesce(${blocker(meta, "executor")},''))`;
	/** The owner already posted this version's delegation, for example by hand. */
	const delegated = sql`(NOT ${isCheck(meta)}) AND EXISTS (SELECT 1 FROM ${workItemComments}
	JOIN ${workItems} ON ${workItems.orgId}=${workItemComments.orgId} AND ${workItems.id}=${workItemComments.workItemId}
	WHERE ${workItemComments.orgId}=${workInteractions.orgId}
	AND ${workItemComments.workItemId}=${workInteractions.workItemId}
	AND ${workItemComments.authorType}='user'
	AND ${workItemComments.authorId}=${workItems.accountableOwnerId}
	AND (${newline} || ${workItemComments.body}) LIKE ('%' || ${newline} || 'Delegation: ' || ${blocker(meta, "executor")} || ' work-version=' || ${blocker(meta, "workVersion")} || ' %'))`;
	/** An older card already asks, or was answered by, the same person about the same version. */
	const duplicate = sql`EXISTS (SELECT 1 FROM work_interactions older
	WHERE older.org_id=${workInteractions.orgId}
	AND older.work_item_id=${workInteractions.workItemId}
	AND older.status IN ('open','resolved')
	AND older.source=${LANE_DELEGATION_SOURCE}
	AND ${same(db, blocker(older, "workVersion", "number"), blocker(meta, "workVersion", "number"))}
	AND ${isCheck(older)} = ${isCheck(meta)}
	AND ${same(db, sql`older.target_type`, workInteractions.targetType)}
	AND ${same(db, sql`older.target_id`, workInteractions.targetId)}
	AND (older.created_at < ${workInteractions.createdAt} OR (older.created_at = ${workInteractions.createdAt} AND older.id < ${workInteractions.id})))`;
	return {
		workInteractions,
		blocker,
		isCheck,
		laneRequest: sql`${workInteractions.source}=${LANE_DELEGATION_SOURCE}`,
		superseded: sql`(${askMoved} OR ${delegated} OR ${duplicate})`,
		storedColumns: Object.fromEntries(
			Object.keys(workInteractionStoredColumns).map((key) => [
				key,
				getColumns(workInteractions)[
					key as keyof typeof workInteractionStoredColumns
				],
			]),
		) as typeof workInteractionStoredColumns,
	};
}

function retire(
	workInteractions: ReturnType<typeof laneSql>["workInteractions"],
	now: string,
) {
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
		verificationCheck?: boolean;
		targetType: string;
		targetId: string;
		now: string;
	},
) {
	const {
		workInteractions,
		blocker,
		isCheck,
		laneRequest,
		superseded,
		storedColumns,
	} = laneSql(db);
	const meta = workInteractions.metadata;
	const sameWork = and(
		eq(workInteractions.orgId, p.orgId),
		eq(workInteractions.workItemId, p.workItemId),
		laneRequest,
	);
	const [retired, [existing]] = await db.batch([
		db
			.update(workInteractions)
			.set(retire(workInteractions, p.now))
			.where(
				and(
					sameWork,
					eq(workInteractions.status, "open"),
					sql`(${superseded} OR NOT ${same(db, blocker(meta, "workVersion", "number"), sql`${p.workVersion}`)})`,
				),
			)
			.returning({ id: workInteractions.id }),
		db
			.select(storedColumns)
			.from(workInteractions)
			.where(
				and(
					sameWork,
					sql`${workInteractions.status} IN ('open','resolved')`,
					sql`${blocker(meta, "workVersion", "number")}=${p.workVersion}`,
					p.verificationCheck ? isCheck(meta) : sql`NOT ${isCheck(meta)}`,
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
	const { workInteractions, laneRequest, superseded } = laneSql(db);
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
		.set(retire(workInteractions, p.now))
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
