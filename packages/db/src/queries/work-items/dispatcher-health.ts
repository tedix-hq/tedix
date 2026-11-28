/**
 * Current lane reports from local supervisors, plus inferred alarm facts about
 * Work waiting while admissions or request-tracker activity have gone quiet.
 *
 * Runs every platform tick, so every read is an index seek per organization:
 * newest rows come from (org_id, started_at) and (organization_id, updated_at)
 * with ORDER BY ... DESC LIMIT 1, never a max() over a whole table.
 */

import {
	DEFAULT_DISPATCHER_HEALTH_SETTINGS,
	resolveDispatcherHealthSettings,
} from "@tedix/api-contract/schemas/dispatcher-health";
import {
	and,
	asc,
	desc,
	eq,
	exists,
	gt,
	inArray,
	isNotNull,
	notExists,
	or,
	sql,
	type SQL,
	type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import { coreTable } from "../../core-store/client";
import { booleanValue, coreStore, jsonRead } from "../../core-store/dialect";
import { policyPacks } from "../../schema/control-plane";
import { kernelRequests } from "../../schema/kernel-requests";
import { organizationMembers } from "../../schema/organization-members";
import { organizations as d1Organizations } from "../../schema/organizations";
import { platformCronCheckpoints as d1PlatformCronCheckpoints } from "../../schema/platform-cron-executions";
import { workInteractions } from "../../schema/work-factory";
import { workAttempts, workItems } from "../../schema/work-items";
import type { DbQueryClient } from "../../query-client";
import {
	dispatcherHealthReports as d1DispatcherHealthReports,
	type DispatcherHealthReportRow,
	type NewDispatcherHealthReportRow,
} from "../../schema/dispatcher-health";

/** `metadata.schema` of the "dispatcher stalled" attention item. */
export const DISPATCHER_HEALTH_SCHEMA = "tedix.dispatcher-health.v1";

export type UpsertDispatcherHealthReportParams = Omit<
	NewDispatcherHealthReportRow,
	"orgId"
> & { orgId: string };

export async function getDispatcherHealthSettings(
	db: DbQueryClient,
	orgId: string,
) {
	const organizations = coreTable(db, d1Organizations);
	const [row] = await db
		.select({ metadata: organizations.metadata })
		.from(organizations)
		.where(eq(organizations.id, orgId))
		.limit(1);
	return resolveDispatcherHealthSettings(row?.metadata?.dispatcherHealth);
}

/** Resolve reported references without exposing another organization's Work. */
export async function listDispatcherWorkReferences(
	db: DbQueryClient,
	orgId: string,
	ids: string[],
) {
	const w = coreTable(db, workItems);
	const unique = [...new Set(ids)];
	const rows: Pick<
		typeof workItems.$inferSelect,
		"id" | "title" | "priority" | "disposition" | "completedAt"
	>[] = [];
	for (let offset = 0; offset < unique.length; offset += 50) {
		rows.push(
			...(await db
				.select({
					id: w.id,
					title: w.title,
					priority: w.priority,
					disposition: w.disposition,
					completedAt: w.completedAt,
				})
				.from(w)
				.where(
					and(
						eq(w.orgId, orgId),
						inArray(w.id, unique.slice(offset, offset + 50)),
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
	const dispatcherHealthReports = coreTable(db, d1DispatcherHealthReports);
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
				topReason: params.topReason ?? null,
				topReasonCount: params.topReasonCount ?? null,
				duty: params.duty ?? null,
				machineName: params.machineName ?? null,
				cliVersion: params.cliVersion ?? null,
				machineTools: params.machineTools ?? null,
				reportedBy: params.reportedBy ?? null,
				rulesSkillId: params.rulesSkillId ?? null,
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
	const dispatcherHealthReports = coreTable(db, d1DispatcherHealthReports);
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
	const p = alias(coreTable(db, policyPacks), "p");
	const enabled = jsonRead(
		db,
		p.definition,
		["kernelRequestCoordinator", "enabled"],
		"boolean",
	);
	// SQLite: `+status` keeps the planner on the (organization_id, version) seek.
	const active =
		coreStore(db) === "postgres"
			? sql`${p.status} = 'active'`
			: sql`+${p.status} = 'active'`;
	return sql`coalesce(${db
		.select({
			enabled: sql`CASE WHEN ${enabled} = ${booleanValue(db, true)} THEN 1 ELSE 0 END`,
		})
		.from(p)
		.where(and(eq(p.organizationId, orgId), active))
		.orderBy(desc(p.version))
		.limit(1)}, 0)`;
}

function lastAdmission(db: DbQueryClient, orgId: SQLWrapper): SQL {
	const a = alias(coreTable(db, workAttempts), "a");
	return sql`${db
		.select({ startedAt: a.startedAt })
		.from(a)
		.where(eq(a.orgId, orgId))
		.orderBy(desc(a.startedAt))
		.limit(1)}`;
}

function lastTrackerAction(db: DbQueryClient, orgId: SQLWrapper): SQL {
	const k = alias(coreTable(db, kernelRequests), "k");
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
	orgIds?: string[],
): Promise<DispatcherActivity> {
	if (orgIds?.length === 0)
		return { lastAdmissionAt: null, lastTrackerActionAt: null };
	const o = alias(coreTable(db, d1Organizations), "o");
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
		.where(
			and(
				sql`${trackerEnabled(db, o.id)} = 1`,
				// bound-params: the only scoped caller passes the five-org cron page.
				orgIds === undefined ? undefined : inArray(o.id, orgIds),
			),
		);
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
	alarmIntervalMinutes?: number;
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
	alarm_interval: number | null;
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

function workAlias(db: DbQueryClient) {
	return alias(coreTable(db, workItems), "w");
}

/** ISO-8601 UTC text for the statement's clock, as stored timestamps are written. */
function nowIso(db: DbQueryClient): SQL {
	return coreStore(db) === "postgres"
		? sql`to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`
		: sql`strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`;
}

function dispatchable(
	db: DbQueryClient,
	w: ReturnType<typeof workAlias>,
	orgId: SQLWrapper,
): SQL | undefined {
	const x = alias(coreTable(db, workAttempts), "x");
	return and(
		eq(w.orgId, orgId),
		eq(w.disposition, "accepted"),
		isNotNull(w.executorId),
		// Literal: it must match the idx_work_items_lane_ready partial index.
		sql`${w.dispatchState} = 'ready'`,
		// Work waiting for its start date is not waiting for a runner.
		sql`(${w.startAt} IS NULL OR ${w.startAt} <= ${nowIso(db)})`,
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
	orgIds?: string[],
): Promise<DispatcherHealthOrgRow[]> {
	if (orgIds?.length === 0) return [];
	// The alarm addresses its item to a user; target_type keeps this on an index.
	const w = workAlias(db);
	const h = alias(coreTable(db, workInteractions), "h");
	const alertOf = (orgId: SQLWrapper) =>
		and(
			eq(h.orgId, orgId),
			eq(h.targetType, "user"),
			sql`${jsonRead(db, h.metadata, ["schema"])} = ${DISPATCHER_HEALTH_SCHEMA}`,
		);
	const o = alias(coreTable(db, d1Organizations), "o");
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
			.from(o)
			// bound-params: the only scoped caller passes the five-org cron page.
			.where(orgIds === undefined ? undefined : inArray(o.id, orgIds)),
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
	const m = alias(coreTable(db, organizationMembers), "m");
	const a = alias(coreTable(db, workInteractions), "a");
	const setting = (name: string, kind?: "number") =>
		jsonRead(db, t.orgMetadata, ["dispatcherHealth", name], kind);
	const rows: OrgRow[] = await db
		.with(c, t)
		.select({
			org_id: t.orgId,
			tracker_enabled: t.trackerEnabled,
			stale_after: sql<
				number | null
			>`${setting("staleAfterMinutes", "number")}`.as("stale_after"),
			alarm_interval: sql<
				number | null
			>`${setting("alarmIntervalMinutes", "number")}`.as("alarm_interval"),
			alarm_enabled: sql<number | string | null>`${setting("enabled")}`.as(
				"alarm_enabled",
			),
			waiting: sql<number>`${db
				.select({ n: sql`count(*)` })
				.from(w)
				.where(dispatchable(db, w, t.orgId))}`.as("waiting"),
			work_item_id: sql<string | null>`${db
				.select({ id: w.id })
				.from(w)
				.where(dispatchable(db, w, t.orgId))
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
						.where(dispatchable(db, w, t.orgId)),
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
		alarmIntervalMinutes: resolveDispatcherHealthSettings({
			// Postgres returns JSON numbers as numeric text.
			alarmIntervalMinutes:
				r.alarm_interval === null ? undefined : Number(r.alarm_interval),
		}).alarmIntervalMinutes,
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

const DISPATCHER_HEALTH_ORGS_PER_TICK = 5;

/**
 * Page candidate organizations before policy/history lookups. Keep open alarms
 * eligible even without active Work so recovery can clear them.
 */
export async function readDispatcherHealthPage(
	db: DbQueryClient,
	environment: string,
	scheduledTime: number,
) {
	const platformCronCheckpoints = coreTable(db, d1PlatformCronCheckpoints);
	const w = workAlias(db);
	const scheduleId = `dispatcher-health:${environment}`;
	const [checkpoint] = await db
		.select({ through: platformCronCheckpoints.through })
		.from(platformCronCheckpoints)
		.where(eq(platformCronCheckpoints.scheduleId, scheduleId))
		.limit(1);
	const previous = checkpoint?.through ?? null;
	const cursor: { after: string; scheduledTime: number } = previous
		? JSON.parse(previous)
		: { after: "", scheduledTime: 0 };
	if (cursor.scheduledTime >= scheduledTime)
		return {
			rows: [],
			activity: { lastAdmissionAt: null, lastTrackerActionAt: null },
			orgsChecked: 0,
			previous,
			next: null,
			scheduleId,
		};
	const o = alias(coreTable(db, d1Organizations), "o");
	const alert = alias(coreTable(db, workInteractions), "active_alert");
	const candidates = await db
		.select({ id: o.id })
		.from(o)
		.where(
			and(
				gt(o.id, cursor.after),
				or(
					exists(
						db
							.select({ one: sql`1` })
							.from(w)
							.where(dispatchable(db, w, o.id)),
					),
					exists(
						db
							.select({ one: sql`1` })
							.from(alert)
							.where(
								and(
									eq(alert.orgId, o.id),
									eq(alert.targetType, "user"),
									eq(alert.status, "open"),
									sql`${jsonRead(db, alert.metadata, ["schema"])} = ${DISPATCHER_HEALTH_SCHEMA}`,
								),
							),
					),
				),
			),
		)
		.orderBy(o.id)
		.limit(DISPATCHER_HEALTH_ORGS_PER_TICK);
	const orgIds = candidates.map((row) => row.id);
	const [allRows, activity] = await Promise.all([
		listDispatcherHealthOrgs(db, orgIds),
		readDispatcherActivity(db, orgIds),
	]);
	// Persist elapsed time per org: clock-modulo checks can starve a paged org.
	const custom = allRows.filter(
		(row) =>
			(row.alarmIntervalMinutes ??
				DEFAULT_DISPATCHER_HEALTH_SETTINGS.alarmIntervalMinutes) >
			DEFAULT_DISPATCHER_HEALTH_SETTINGS.alarmIntervalMinutes,
	);
	const checks = custom.length
		? await db
				.select({
					scheduleId: platformCronCheckpoints.scheduleId,
					through: platformCronCheckpoints.through,
				})
				.from(platformCronCheckpoints)
				.where(
					// bound-params: custom is a subset of the five-org candidate page.
					inArray(
						platformCronCheckpoints.scheduleId,
						custom.map((row) => `${scheduleId}:${row.orgId}`),
					),
				)
		: [];
	const lastChecks = new Map(
		checks.map((row) => [row.scheduleId, Number(row.through)]),
	);
	const rows = allRows.filter((row) => {
		const last = lastChecks.get(`${scheduleId}:${row.orgId}`);
		return (
			last === undefined ||
			scheduledTime - last >=
				(row.alarmIntervalMinutes ??
					DEFAULT_DISPATCHER_HEALTH_SETTINGS.alarmIntervalMinutes) *
					60000
		);
	});
	return {
		rows,
		activity,
		cadenceChecks: rows
			.filter(
				(row) =>
					(row.alarmIntervalMinutes ??
						DEFAULT_DISPATCHER_HEALTH_SETTINGS.alarmIntervalMinutes) >
					DEFAULT_DISPATCHER_HEALTH_SETTINGS.alarmIntervalMinutes,
			)
			.map((row) => ({
				scheduleId: `${scheduleId}:${row.orgId}`,
				through: String(scheduledTime),
			})),
		orgsChecked: candidates.length,
		previous,
		scheduleId,
		next: JSON.stringify({
			after:
				candidates.length < DISPATCHER_HEALTH_ORGS_PER_TICK
					? ""
					: candidates.at(-1)!.id,
			scheduledTime,
		}),
	};
}

/** Advance only after every alarm in the page was handled successfully. */
export async function advanceDispatcherHealthPage(
	db: DbQueryClient,
	page: {
		scheduleId: string;
		previous: string | null;
		next: string | null;
		cadenceChecks?: { scheduleId: string; through: string }[];
	},
) {
	if (page.next === null) return;
	const platformCronCheckpoints = coreTable(db, d1PlatformCronCheckpoints);
	// Epoch milliseconds exceed a Postgres integer.
	const integer = coreStore(db) === "postgres" ? sql`bigint` : sql`integer`;
	await db.batch([
		db
			.insert(platformCronCheckpoints)
			.values({ scheduleId: page.scheduleId, through: page.next })
			.onConflictDoUpdate({
				target: platformCronCheckpoints.scheduleId,
				set: { through: page.next },
				setWhere:
					page.previous === null
						? sql`FALSE`
						: eq(platformCronCheckpoints.through, page.previous),
			}),
		...(page.cadenceChecks ?? []).map((check) =>
			db
				.insert(platformCronCheckpoints)
				.values(check)
				.onConflictDoUpdate({
					target: platformCronCheckpoints.scheduleId,
					set: { through: check.through },
					setWhere: sql`cast(${platformCronCheckpoints.through} as ${integer}) < ${Number(check.through)}`,
				}),
		),
	]);
}
