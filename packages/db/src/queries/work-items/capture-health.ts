/**
 * Decision-capture health: whether captured agent turns, tedi reply drafts
 * and lesson deliveries are still arriving for a user.
 *
 * Capture is a local opt-in on the user's machine, so the server sees it only
 * through what it produces: a user "has capture on" when a decision-capture
 * question addressed to them exists since `activeSince`. A silent day after
 * that is the failure this module exists to surface.
 */

import { sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";

const DECISION_CAPTURE_SCHEMA = "tedix.decision-capture.v1";
/** `metadata.schema` of the "capture may be broken" item. */
export const CAPTURE_HEALTH_SCHEMA = "tedix.capture-health.v1";
const LESSON_DELIVERY_SURFACE = "lesson_delivery";

export interface CaptureHealthCounts {
	/** Decision-capture questions addressed to the user. */
	turns: number;
	/** Tedi reply drafts on those questions. */
	drafts: number;
	/** Lesson deliveries to the user's agent sessions. */
	lessons: number;
}

type CountRow = {
	turns: number | null;
	drafts: number | null;
	lessons: number | null;
};

const counts = (row: CountRow | undefined): CaptureHealthCounts => ({
	turns: Number(row?.turns ?? 0),
	drafts: Number(row?.drafts ?? 0),
	lessons: Number(row?.lessons ?? 0),
});

function countColumns(orgId: unknown, userId: unknown, since: string) {
	return sql`
		(
			SELECT count(*) FROM work_interactions t
			WHERE t.org_id = ${orgId}
				AND t.target_type = 'user'
				AND t.target_id = ${userId}
				AND t.created_at >= ${since}
				AND json_extract(t.metadata, '$.schema') = ${DECISION_CAPTURE_SCHEMA}
		) AS turns,
		(
			SELECT count(*) FROM work_interaction_reply_drafts d
			JOIN work_interactions q ON q.org_id = d.org_id AND q.id = d.interaction_id
			WHERE d.org_id = ${orgId}
				AND q.target_type = 'user'
				AND q.target_id = ${userId}
				AND d.created_at >= ${since}
		) AS drafts,
		(
			SELECT count(*) FROM learning_interaction_events e
			WHERE e.organization_id = ${orgId}
				AND e.actor_type = 'user'
				AND e.actor_id = ${userId}
				AND e.surface = ${LESSON_DELIVERY_SURFACE}
				AND e.event_kind = 'delivered'
				AND e.occurred_at >= ${since}
		) AS lessons`;
}

/** One user's counts since `since`. */
export async function getCaptureHealth(
	db: DbQueryClient,
	p: { orgId: string; userId: string; since: string },
): Promise<CaptureHealthCounts> {
	const [row] = await db.all<CountRow>(
		sql`SELECT ${countColumns(p.orgId, p.userId, p.since)}`,
	);
	return counts(row);
}

export interface CaptureHealthRow extends CaptureHealthCounts {
	orgId: string;
	userId: string;
	/** Context of the user's newest captured turn, for the health item. */
	projectId: string | null;
	workItemId: string | null;
	caseId: string | null;
	/** An unexpired open health item already waits for the user. */
	alertOpen: boolean;
}

type HealthRow = CountRow & {
	org_id: string;
	user_id: string;
	project_id: string | null;
	work_item_id: string | null;
	case_id: string | null;
	alert_open: number | null;
};

/**
 * Every user with capture on (a captured turn since `activeSince`), across
 * organizations, with their counts since `since`. Platform maintenance only.
 */
export async function listCaptureHealth(
	db: DbQueryClient,
	p: { since: string; activeSince: string; now: string },
): Promise<CaptureHealthRow[]> {
	const rows = await db.all<HealthRow>(sql`
		WITH latest AS (
			SELECT org_id, target_id AS user_id, max(created_at) AS last_at
			FROM work_interactions
			WHERE target_type = 'user'
				AND created_at >= ${p.activeSince}
				AND json_extract(metadata, '$.schema') = ${DECISION_CAPTURE_SCHEMA}
			GROUP BY org_id, target_id
		)
		SELECT
			u.org_id AS org_id,
			u.user_id AS user_id,
			c.project_id AS project_id,
			c.work_item_id AS work_item_id,
			c.case_id AS case_id,
			${countColumns(sql`u.org_id`, sql`u.user_id`, p.since)},
			EXISTS (
				SELECT 1 FROM work_interactions h
				WHERE h.org_id = u.org_id
					AND h.target_type = 'user'
					AND h.target_id = u.user_id
					AND h.status = 'open'
					AND (h.expires_at IS NULL OR h.expires_at > ${p.now})
					AND json_extract(h.metadata, '$.schema') = ${CAPTURE_HEALTH_SCHEMA}
			) AS alert_open
		FROM latest u
		JOIN work_interactions c ON c.id = (
			SELECT n.id FROM work_interactions n
			WHERE n.org_id = u.org_id
				AND n.target_type = 'user'
				AND n.target_id = u.user_id
				AND n.created_at = u.last_at
				AND json_extract(n.metadata, '$.schema') = ${DECISION_CAPTURE_SCHEMA}
			ORDER BY n.id
			LIMIT 1
		)
		ORDER BY u.org_id, u.user_id
	`);
	return rows.map((row) => ({
		orgId: row.org_id,
		userId: row.user_id,
		projectId: row.project_id,
		workItemId: row.work_item_id,
		caseId: row.case_id,
		alertOpen: Boolean(row.alert_open),
		...counts(row),
	}));
}
