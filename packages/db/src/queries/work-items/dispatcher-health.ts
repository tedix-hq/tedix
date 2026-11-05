/**
 * Current lane reports from local supervisors, plus inferred alarm facts about
 * Work waiting while admissions or request-tracker activity have gone quiet.
 *
 * Runs every platform tick, so every read is an index seek per organization:
 * newest rows come from (org_id, started_at) and (organization_id, updated_at)
 * with ORDER BY ... DESC LIMIT 1, never a max() over a whole table.
 */

import {
	and,
	asc,
	desc,
	eq,
	exists,
	inArray,
	isNotNull,
	notExists,
	or,
	sql,
	type SQL,
	type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { policyPacks } from "../../schema/control-plane";
import { kernelRequests } from "../../schema/kernel-requests";
import { organizationMembers } from "../../schema/organization-members";
import { organizations } from "../../schema/organizations";
import { workInteractions } from "../../schema/work-factory";
import { workAttempts, workItems } from "../../schema/work-items";
import type { DbQueryClient } from "../../query-client";
import {
	dispatcherHealthReports,
	type DispatcherHealthReportRow,
	type NewDispatcherHealthReportRow,
} from "../../schema/dispatcher-health";

/** `metadata.schema` of the "dispatcher stalled" attention item. */
export const DISPATCHER_HEALTH_SCHEMA = "tedix.dispatcher-health.v1";

export type UpsertDispatcherHealthReportParams = Omit<
	NewDispatcherHealthReportRow,
	"orgId"
> & { orgId: string };

/** Resolve reported references without exposing another organization's Work. */
export async function listDispatcherWorkReferences(
	db: DbQueryClient,
	orgId: string,
	ids: string[],
) {
	const unique = [...new Set(ids)];
	const rows: Pick<
		typeof workItems.$inferSelect,
		"id" | "title" | "disposition" | "completedAt"
	>[] = [];
	for (let offset = 0; offset < unique.length; offset += 50) {
		rows.push(
			...(await db
				.select({
					id: workItems.id,
					title: workItems.title,
					disposition: workItems.disposition,
					completedAt: workItems.completedAt,
				})
				.from(workItems)
				.where(
					and(
						eq(workItems.orgId, orgId),
						inArray(workItems.id, unique.slice(offset, offset + 50)),
					),
				)),
		);
	}
	return rows;
}

/** Replace one reporter's current snapshot for one executor lane. */
export async function upsertDispatcherHealthReport(
	db: DbQueryClient,
	params: UpsertDispatcherHealthReportParams,
): Promise<DispatcherHealthReportRow> {
	const [row] = await db
		.insert(dispatcherHealthReports)
		.values(params)
		.onConflictDoUpdate({
			target: [
				dispatcherHealthReports.orgId,
				dispatcherHealthReports.reporterId,
				dispatcherHealthReports.executor,
				dispatcherHealthReports.lane,
			],
			set: {
				running: params.running,
				observedAt: params.observedAt,
				reportedAt: params.reportedAt,
				lastAdmissionAt: params.lastAdmissionAt ?? null,
				slotsInUse: params.slotsInUse,
				slotsTotal: params.slotsTotal,
				topReason: params.topReason ?? null,
				topReasonCount: params.topReasonCount ?? null,
				duty: params.duty ?? null,
			},
		})
		.returning();
	if (!row) throw new Error("Dispatcher health report upsert returned no row");
	return row;
}

/** Current dispatcher lane reports for exactly one organization. */
export function listDispatcherHealthReports(
	db: DbQueryClient,
	orgId: string,
): Promise<DispatcherHealthReportRow[]> {
	return db
		.select()
		.from(dispatcherHealthReports)
		.where(eq(dispatcherHealthReports.orgId, orgId))
		.orderBy(
			asc(dispatcherHealthReports.executor),
			asc(dispatcherHealthReports.lane),
			asc(dispatcherHealthReports.reporterId),
		);
}

/**
 * The organization's newest active policy pack enables the request tracker.
 * Only these organizations run the dispatcher, so only they can stall.
 */
function trackerEnabled(db: DbQueryClient, orgId: SQLWrapper): SQL {
	const p = alias(policyPacks, "p");
	// `+status` keeps the planner on the (organization_id, version) seek.
	return sql`coalesce(${db
		.select({
			enabled: sql`json_extract(${p.definition}, '$.kernelRequestCoordinator.enabled') = 1`,
		})
		.from(p)
		.where(and(eq(p.organizationId, orgId), sql`+${p.status} = 'active'`))
		.orderBy(desc(p.version))
		.limit(1)}, 0)`;
}

function lastAdmission(db: DbQueryClient, orgId: SQLWrapper): SQL {
	const a = alias(workAttempts, "a");
	return sql`${db
		.select({ startedAt: a.startedAt })
		.from(a)
		.where(eq(a.orgId, orgId))
		.orderBy(desc(a.startedAt))
		.limit(1)}`;
}

function lastTrackerAction(db: DbQueryClient, orgId: SQLWrapper): SQL {
	const k = alias(kernelRequests, "k");
	return sql`${db
		.select({ updatedAt: k.updatedAt })
		.from(k)
		.where(eq(k.organizationId, orgId))
		.orderBy(desc(k.updatedAt))
		.limit(1)}`;
}

export interface DispatcherActivity {
	/** Newest Work Attempt start across organizations that run the request tracker. */
	lastAdmissionAt: string | null;
	/** Newest request-tracker (kernel request) transition across those organizations. */
	lastTrackerActionAt: string | null;
}

/** Platform timestamps over tracker-enabled organizations; no tenant identifiers leave this query. */
export async function readDispatcherActivity(
	db: DbQueryClient,
): Promise<DispatcherActivity> {
	const o = alias(organizations, "o");
	const [row] = await db
		.select({
			last_admission_at: sql<string | null>`max(${lastAdmission(db, o.id)})`.as(
				"last_admission_at",
			),
			last_tracker_at: sql<
				string | null
			>`max(${lastTrackerAction(db, o.id)})`.as("last_tracker_at"),
		})
		.from(o)
		.where(sql`${trackerEnabled(db, o.id)} = 1`);
	return {
		lastAdmissionAt: row?.last_admission_at ?? null,
		lastTrackerActionAt: row?.last_tracker_at ?? null,
	};
}

export interface DispatcherHealthOrgRow {
	orgId: string;
	/** Active policy pack enables the request tracker; only then can the dispatcher stall. */
	trackerEnabled: boolean;
	/** Org config `metadata.dispatcherHealth.staleAfterMinutes`; null = platform default. */
	staleAfterMinutes: number | null;
	/** Org config `metadata.dispatcherHealth.enabled === false` turns the alarm off. */
	alarmEnabled: boolean;
	/** Accepted, lane-ready Work with an executor and no active Attempt. */
	dispatchableCount: number;
	/** Oldest such item: context for the attention item. */
	workItemId: string | null;
	lastAdmissionAt: string | null;
	lastTrackerActionAt: string | null;
	ownerUserId: string | null;
	openAlertId: string | null;
	openAlertVersion: number | null;
	openAlertCreatorId: string | null;
	/** Newest alert the owner answered; the alarm stays quiet for that stall. */
	answeredAlertAt: string | null;
}

type OrgRow = {
	org_id: string;
	tracker_enabled: number;
	stale_after: number | null;
	alarm_enabled: number | string | null;
	waiting: number;
	work_item_id: string | null;
	last_admission_at: string | null;
	last_tracker_at: string | null;
	owner_user_id: string | null;
	alert_id: string | null;
	alert_version: number | null;
	alert_creator_id: string | null;
	answered_alert_at: string | null;
};

const w = alias(workItems, "w");

function dispatchable(db: DbQueryClient, orgId: SQLWrapper): SQL | undefined {
	const x = alias(workAttempts, "x");
	return and(
		eq(w.orgId, orgId),
		eq(w.disposition, "accepted"),
		sql`json_extract(${w.metadata}, '$.executor') IS NOT NULL`,
		sql`(json_type(${w.metadata}, '$.laneDispatch') IS NULL
			OR json_extract(${w.metadata}, '$.laneDispatch.state') = 'ready') = 1`,
		notExists(
			db
				.select({ one: sql`1` })
				.from(x)
				.where(
					and(
						eq(x.orgId, w.orgId),
						eq(x.workItemId, w.id),
						// Literal list: it must match the uniq_work_attempt_active partial index.
						sql`${x.runtimeState} IN ('queued', 'running', 'waiting', 'retrying')`,
					),
				),
		),
	);
}

/**
 * Tracker-enabled organizations with dispatchable Work, and any organization
 * with an open dispatcher alert (so it can be cleared), with everything the
 * alarm needs to raise or clear one item per organization. Every other
 * organization is dropped before any per-organization lookup runs.
 */
export async function listDispatcherHealthOrgs(
	db: DbQueryClient,
): Promise<DispatcherHealthOrgRow[]> {
	// The alarm addresses its item to a user; target_type keeps this on an index.
	const h = alias(workInteractions, "h");
	const alertOf = (orgId: SQLWrapper) =>
		and(
			eq(h.orgId, orgId),
			eq(h.targetType, "user"),
			sql`json_extract(${h.metadata}, '$.schema') = ${DISPATCHER_HEALTH_SCHEMA}`,
		);
	const o = alias(organizations, "o");
	const c = db.$with("c").as(
		db
			.select({
				orgId: sql<string>`${o.id}`.as("org_id"),
				orgMetadata: sql<string | null>`${o.metadata}`.as(
					"organization_metadata",
				),
				trackerEnabled: sql<number>`${trackerEnabled(db, o.id)}`.as(
					"tracker_enabled",
				),
				alertId: sql<string | null>`${db
					.select({ id: h.id })
					.from(h)
					.where(and(alertOf(o.id), eq(h.status, "open")))
					.orderBy(h.createdAt, h.id)
					.limit(1)}`.as("alert_id"),
			})
			.from(o),
	);
	const t = db.$with("t").as(
		db
			.select({
				orgId: c.orgId,
				orgMetadata: c.orgMetadata,
				trackerEnabled: c.trackerEnabled,
				alertId: c.alertId,
			})
			.from(c)
			.where(or(eq(c.trackerEnabled, 1), isNotNull(c.alertId))),
	);
	const m = alias(organizationMembers, "m");
	const a = alias(workInteractions, "a");
	const rows: OrgRow[] = await db
		.with(c, t)
		.select({
			org_id: t.orgId,
			tracker_enabled: t.trackerEnabled,
			stale_after: sql<
				number | null
			>`json_extract(${t.orgMetadata}, '$.dispatcherHealth.staleAfterMinutes')`.as(
				"stale_after",
			),
			alarm_enabled: sql<
				number | string | null
			>`json_extract(${t.orgMetadata}, '$.dispatcherHealth.enabled')`.as(
				"alarm_enabled",
			),
			waiting: sql<number>`${db
				.select({ n: sql`count(*)` })
				.from(w)
				.where(dispatchable(db, t.orgId))}`.as("waiting"),
			work_item_id: sql<string | null>`${db
				.select({ id: w.id })
				.from(w)
				.where(dispatchable(db, t.orgId))
				.orderBy(w.createdAt, w.id)
				.limit(1)}`.as("work_item_id"),
			last_admission_at: sql<string | null>`${lastAdmission(db, t.orgId)}`.as(
				"last_admission_at",
			),
			last_tracker_at: sql<string | null>`${lastTrackerAction(db, t.orgId)}`.as(
				"last_tracker_at",
			),
			owner_user_id: sql<string | null>`${db
				.select({ userId: m.userId })
				.from(m)
				.where(
					and(
						eq(m.organizationId, t.orgId),
						eq(m.role, "owner"),
						eq(m.status, "active"),
						eq(m.kind, "human"),
						isNotNull(m.userId),
					),
				)
				.orderBy(m.id)
				.limit(1)}`.as("owner_user_id"),
			alert_id: t.alertId,
			alert_version: sql<number | null>`${a.version}`.as("alert_version"),
			alert_creator_id: sql<string | null>`${a.creatorId}`.as(
				"alert_creator_id",
			),
			answered_alert_at: sql<string | null>`${db
				.select({ at: sql`max(${h.createdAt})` })
				.from(h)
				.where(and(alertOf(t.orgId), eq(h.status, "resolved")))}`.as(
				"answered_alert_at",
			),
		})
		.from(t)
		.leftJoin(a, and(eq(a.orgId, t.orgId), eq(a.id, t.alertId)))
		.where(
			or(
				isNotNull(t.alertId),
				exists(
					db
						.select({ one: sql`1` })
						.from(w)
						.where(dispatchable(db, t.orgId)),
				),
			),
		)
		.orderBy(t.orgId);
	return rows.map((r) => ({
		orgId: r.org_id,
		trackerEnabled: Number(r.tracker_enabled) === 1,
		staleAfterMinutes:
			r.stale_after !== null && Number(r.stale_after) > 0
				? Number(r.stale_after)
				: null,
		alarmEnabled: !(r.alarm_enabled === 0 || r.alarm_enabled === "false"),
		dispatchableCount: Number(r.waiting),
		workItemId: r.work_item_id,
		lastAdmissionAt: r.last_admission_at,
		lastTrackerActionAt: r.last_tracker_at,
		ownerUserId: r.owner_user_id,
		openAlertId: r.alert_id,
		openAlertVersion: r.alert_version === null ? null : Number(r.alert_version),
		openAlertCreatorId: r.alert_creator_id,
		answeredAlertAt: r.answered_alert_at,
	}));
}
