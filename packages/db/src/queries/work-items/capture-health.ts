/**
 * Decision-capture health: whether captured agent turns, tedi reply drafts
 * and lesson deliveries are still arriving for a user.
 *
 * Capture is a local opt-in on the user's machine, so the server sees it only
 * through what it produces: a user "has capture on" when a decision-capture
 * question addressed to them exists since `activeSince`. A silent day after
 * that is the failure this module exists to surface.
 */

import {
	and,
	eq,
	exists,
	gt,
	gte,
	isNull,
	or,
	sql,
	type SQLWrapper,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../../query-client";
import { learningInteractionEvents } from "../../schema/learning-feedback";
import {
	workInteractionReplyDrafts,
	workInteractions,
} from "../../schema/work-factory";

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

/** Each count is an aggregate without GROUP BY, so it always yields one row. */
function countQueries(
	db: DbQueryClient,
	orgId: SQLWrapper | string,
	userId: SQLWrapper | string,
	since: string,
) {
	const t = alias(workInteractions, "t");
	const d = alias(workInteractionReplyDrafts, "d");
	const q = alias(workInteractions, "q");
	const e = alias(learningInteractionEvents, "e");
	return {
		turns: db
			.select({ n: sql<number>`count(*)`.as("turns") })
			.from(t)
			.where(
				and(
					eq(t.orgId, orgId),
					eq(t.targetType, "user"),
					eq(t.targetId, userId),
					gte(t.createdAt, since),
					sql`json_extract(${t.metadata}, '$.schema') = ${DECISION_CAPTURE_SCHEMA}`,
				),
			),
		drafts: db
			.select({ n: sql<number>`count(*)`.as("drafts") })
			.from(d)
			.innerJoin(q, and(eq(q.orgId, d.orgId), eq(q.id, d.interactionId)))
			.where(
				and(
					eq(d.orgId, orgId),
					eq(q.targetType, "user"),
					eq(q.targetId, userId),
					gte(d.createdAt, since),
				),
			),
		lessons: db
			.select({ n: sql<number>`count(*)`.as("lessons") })
			.from(e)
			.where(
				and(
					eq(e.organizationId, orgId),
					eq(e.actorType, "user"),
					eq(e.actorId, userId),
					eq(e.surface, LESSON_DELIVERY_SURFACE),
					eq(e.eventKind, "delivered"),
					gte(e.occurredAt, since),
				),
			),
	};
}

/** One user's counts since `since`. */
export async function getCaptureHealth(
	db: DbQueryClient,
	p: { orgId: string; userId: string; since: string },
): Promise<CaptureHealthCounts> {
	const queries = countQueries(db, p.orgId, p.userId, p.since);
	const turns = queries.turns.as("turns_count");
	const drafts = queries.drafts.as("drafts_count");
	const lessons = queries.lessons.as("lessons_count");
	const [row] = await db
		.select({ turns: turns.n, drafts: drafts.n, lessons: lessons.n })
		.from(turns)
		.crossJoin(drafts)
		.crossJoin(lessons);
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
	const latest = db.$with("latest").as(
		db
			.select({
				orgId: workInteractions.orgId,
				userId: sql<string>`${workInteractions.targetId}`.as("user_id"),
				lastAt: sql<string>`max(${workInteractions.createdAt})`.as("last_at"),
			})
			.from(workInteractions)
			.where(
				and(
					eq(workInteractions.targetType, "user"),
					gte(workInteractions.createdAt, p.activeSince),
					sql`json_extract(${workInteractions.metadata}, '$.schema') = ${DECISION_CAPTURE_SCHEMA}`,
				),
			)
			.groupBy(workInteractions.orgId, workInteractions.targetId),
	);
	const c = alias(workInteractions, "c");
	const h = alias(workInteractions, "h");
	const n = alias(workInteractions, "n");
	const queries = countQueries(db, latest.orgId, latest.userId, p.since);
	const rows: HealthRow[] = await db
		.with(latest)
		.select({
			org_id: sql<string>`${latest.orgId}`.as("org_id"),
			user_id: sql<string>`${latest.userId}`.as("user_id"),
			project_id: sql<string | null>`${c.projectId}`.as("project_id"),
			work_item_id: sql<string | null>`${c.workItemId}`.as("work_item_id"),
			case_id: sql<string | null>`${c.caseId}`.as("case_id"),
			turns: sql<number | null>`${queries.turns}`.as("turns"),
			drafts: sql<number | null>`${queries.drafts}`.as("drafts"),
			lessons: sql<number | null>`${queries.lessons}`.as("lessons"),
			alert_open: sql<number | null>`${exists(
				db
					.select({ one: sql`1` })
					.from(h)
					.where(
						and(
							eq(h.orgId, latest.orgId),
							eq(h.targetType, "user"),
							eq(h.targetId, latest.userId),
							eq(h.status, "open"),
							or(isNull(h.expiresAt), gt(h.expiresAt, p.now)),
							sql`json_extract(${h.metadata}, '$.schema') = ${CAPTURE_HEALTH_SCHEMA}`,
						),
					),
			)}`.as("alert_open"),
		})
		.from(latest)
		.innerJoin(
			c,
			eq(
				c.id,
				db
					.select({ id: n.id })
					.from(n)
					.where(
						and(
							eq(n.orgId, latest.orgId),
							eq(n.targetType, "user"),
							eq(n.targetId, latest.userId),
							eq(n.createdAt, latest.lastAt),
							sql`json_extract(${n.metadata}, '$.schema') = ${DECISION_CAPTURE_SCHEMA}`,
						),
					)
					.orderBy(n.id)
					.limit(1),
			),
		)
		.orderBy(latest.orgId, latest.userId);
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
