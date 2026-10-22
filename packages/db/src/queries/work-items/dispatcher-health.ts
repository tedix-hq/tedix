/**
 * Dispatcher health facts: whether Work waits for a lane while the two signs of
 * a working dispatcher (a Work Attempt admission, a request-tracker action)
 * have both gone quiet. Read-only; the alarm job in apps/api acts on them.
 *
 * Runs every platform tick, so every read is an index seek per organization:
 * newest rows come from (org_id, started_at) and (organization_id, updated_at)
 * with ORDER BY ... DESC LIMIT 1, never a max() over a whole table.
 */

import { sql, type SQL } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";

/** `metadata.schema` of the "dispatcher stalled" attention item. */
export const DISPATCHER_HEALTH_SCHEMA = "tedix.dispatcher-health.v1";

/**
 * The organization's newest active policy pack enables the request tracker.
 * Only these organizations run the dispatcher, so only they can stall.
 */
function trackerEnabled(orgId: SQL): SQL {
	return sql`coalesce((SELECT json_extract(p.definition, '$.kernelRequestCoordinator.enabled') = 1
		FROM policy_packs p
		WHERE p.organization_id = ${orgId} AND +p.status = 'active'
		ORDER BY p.version DESC LIMIT 1), 0)`;
}

function lastAdmission(orgId: SQL): SQL {
	return sql`(SELECT a.started_at FROM work_attempts a
		WHERE a.org_id = ${orgId} ORDER BY a.started_at DESC LIMIT 1)`;
}

function lastTrackerAction(orgId: SQL): SQL {
	return sql`(SELECT k.updated_at FROM kernel_requests k
		WHERE k.organization_id = ${orgId} ORDER BY k.updated_at DESC LIMIT 1)`;
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
	const [row] = await db.all<{
		last_admission_at: string | null;
		last_tracker_at: string | null;
	}>(sql`
		SELECT
			max(${lastAdmission(sql`o.id`)}) AS last_admission_at,
			max(${lastTrackerAction(sql`o.id`)}) AS last_tracker_at
		FROM organizations o
		WHERE ${trackerEnabled(sql`o.id`)} = 1
	`);
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

function dispatchable(): SQL {
	return sql`
		w.org_id = t.org_id
		AND w.disposition = 'accepted'
		AND json_extract(w.metadata, '$.executor') IS NOT NULL
		AND (json_type(w.metadata, '$.laneDispatch') IS NULL
			OR json_extract(w.metadata, '$.laneDispatch.state') = 'ready') = 1
		AND NOT EXISTS (
			SELECT 1 FROM work_attempts x
			WHERE x.org_id = w.org_id AND x.work_item_id = w.id
				AND x.runtime_state IN ('queued', 'running', 'waiting', 'retrying')
		)`;
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
	const alertOf = (orgId: SQL) => sql`h.org_id = ${orgId}
		AND h.target_type = 'user'
		AND json_extract(h.metadata, '$.schema') = ${DISPATCHER_HEALTH_SCHEMA}`;
	const rows = await db.all<OrgRow>(sql`
		WITH c AS (
			SELECT
				o.id AS org_id,
				o.metadata AS org_metadata,
				${trackerEnabled(sql`o.id`)} AS tracker_enabled,
				(SELECT h.id FROM work_interactions h
					WHERE ${alertOf(sql`o.id`)} AND h.status = 'open'
					ORDER BY h.created_at, h.id LIMIT 1) AS alert_id
			FROM organizations o
		),
		t AS (
			SELECT * FROM c WHERE c.tracker_enabled = 1 OR c.alert_id IS NOT NULL
		)
		SELECT
			t.org_id,
			t.tracker_enabled,
			json_extract(t.org_metadata, '$.dispatcherHealth.staleAfterMinutes') AS stale_after,
			json_extract(t.org_metadata, '$.dispatcherHealth.enabled') AS alarm_enabled,
			(SELECT count(*) FROM work_items w WHERE ${dispatchable()}) AS waiting,
			(SELECT w.id FROM work_items w WHERE ${dispatchable()}
				ORDER BY w.created_at, w.id LIMIT 1) AS work_item_id,
			${lastAdmission(sql`t.org_id`)} AS last_admission_at,
			${lastTrackerAction(sql`t.org_id`)} AS last_tracker_at,
			(SELECT m.user_id FROM organization_members m
				WHERE m.organization_id = t.org_id AND m.role = 'owner'
					AND m.status = 'active' AND m.kind = 'human' AND m.user_id IS NOT NULL
				ORDER BY m.id LIMIT 1) AS owner_user_id,
			t.alert_id,
			a.version AS alert_version,
			a.creator_id AS alert_creator_id,
			(SELECT max(h.created_at) FROM work_interactions h
				WHERE ${alertOf(sql`t.org_id`)} AND h.status = 'resolved') AS answered_alert_at
		FROM t
		LEFT JOIN work_interactions a ON a.org_id = t.org_id AND a.id = t.alert_id
		WHERE t.alert_id IS NOT NULL
			OR EXISTS (SELECT 1 FROM work_items w WHERE ${dispatchable()})
		ORDER BY t.org_id
	`);
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
