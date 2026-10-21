/**
 * Dispatcher health facts: whether Work waits for a lane while the two signs of
 * a working dispatcher (a Work Attempt admission, a request-tracker action)
 * have both gone quiet. Read-only; the alarm job in apps/api acts on them.
 */

import { sql, type SQL } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";

/** `metadata.schema` of the "dispatcher stalled" attention item. */
export const DISPATCHER_HEALTH_SCHEMA = "tedix.dispatcher-health.v1";

export interface DispatcherActivity {
	/** Newest Work Attempt start across all organizations. */
	lastAdmissionAt: string | null;
	/** Newest request-tracker (kernel request) transition across all organizations. */
	lastTrackerActionAt: string | null;
}

/** Platform-wide timestamps; no tenant identifiers leave this query. */
export async function readDispatcherActivity(
	db: DbQueryClient,
): Promise<DispatcherActivity> {
	const [row] = await db.all<{
		last_admission_at: string | null;
		last_tracker_at: string | null;
	}>(sql`
		SELECT
			(SELECT max(started_at) FROM work_attempts) AS last_admission_at,
			(SELECT max(updated_at) FROM kernel_requests) AS last_tracker_at
	`);
	return {
		lastAdmissionAt: row?.last_admission_at ?? null,
		lastTrackerActionAt: row?.last_tracker_at ?? null,
	};
}

export interface DispatcherHealthOrgRow {
	orgId: string;
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

function dispatchable(): SQL {
	return sql`
		w.org_id = o.id
		AND w.disposition = 'accepted'
		AND json_extract(w.metadata, '$.executor') IS NOT NULL
		AND (json_type(w.metadata, '$.laneDispatch') IS NULL
			OR json_extract(w.metadata, '$.laneDispatch.state') = 'ready')
		AND NOT EXISTS (
			SELECT 1 FROM work_attempts x
			WHERE x.org_id = w.org_id AND x.work_item_id = w.id
				AND x.runtime_state IN ('queued', 'running', 'waiting', 'retrying')
		)`;
}

/**
 * Organizations that have dispatchable Work or an open dispatcher alert, with
 * everything the alarm needs to raise or clear one item per organization.
 */
export async function listDispatcherHealthOrgs(
	db: DbQueryClient,
): Promise<DispatcherHealthOrgRow[]> {
	const alertOf = sql`h.org_id = o.id
		AND json_extract(h.metadata, '$.schema') = ${DISPATCHER_HEALTH_SCHEMA}`;
	const rows = await db.all<OrgRow>(sql`
		SELECT t.*, a.version AS alert_version, a.creator_id AS alert_creator_id
		FROM (
			SELECT
				o.id AS org_id,
				json_extract(o.metadata, '$.dispatcherHealth.staleAfterMinutes') AS stale_after,
				json_extract(o.metadata, '$.dispatcherHealth.enabled') AS alarm_enabled,
				(SELECT count(*) FROM work_items w WHERE ${dispatchable()}) AS waiting,
				(SELECT w.id FROM work_items w WHERE ${dispatchable()}
					ORDER BY w.created_at, w.id LIMIT 1) AS work_item_id,
				(SELECT max(a.started_at) FROM work_attempts a WHERE a.org_id = o.id) AS last_admission_at,
				(SELECT max(k.updated_at) FROM kernel_requests k WHERE k.organization_id = o.id) AS last_tracker_at,
				(SELECT m.user_id FROM organization_members m
					WHERE m.organization_id = o.id AND m.role = 'owner'
						AND m.status = 'active' AND m.kind = 'human' AND m.user_id IS NOT NULL
					ORDER BY m.id LIMIT 1) AS owner_user_id,
				(SELECT h.id FROM work_interactions h WHERE ${alertOf} AND h.status = 'open'
					ORDER BY h.created_at, h.id LIMIT 1) AS alert_id,
				(SELECT max(h.created_at) FROM work_interactions h WHERE ${alertOf} AND h.status = 'resolved') AS answered_alert_at
			FROM organizations o
		) t
		LEFT JOIN work_interactions a ON a.org_id = t.org_id AND a.id = t.alert_id
		WHERE t.waiting > 0 OR t.alert_id IS NOT NULL
		ORDER BY t.org_id
	`);
	return rows.map((r) => ({
		orgId: r.org_id,
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
