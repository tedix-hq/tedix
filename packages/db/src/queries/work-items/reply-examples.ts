/**
 * A user's own past answers to decision-capture questions, as few-shot
 * examples for drafting their next reply.
 *
 * An example is a resolved decision-capture question targeted at the user and
 * its resolving answer written by that same user: a reply typed to the agent
 * (`metadata.source = "user-reply"`) or an answer given in Tedix OS
 * (`"os-inbox"`), which is where accepted, edited, replaced and overridden
 * drafts land. An answer whose body is an auto-sent tedi draft
 * (`draftOutcome = "auto-sent"`) is the tedi's words, not the user's, and is
 * never an example. Question prompts and reply bodies are stored redacted at
 * capture, so nothing here redacts again.
 */

import { and, desc, eq, inArray, ne, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	workInteractionResponses,
	workInteractions,
} from "../../schema/work-factory";

const DECISION_CAPTURE_SCHEMA = "tedix.decision-capture.v1";
/** Answer sources whose body the target user wrote or chose. */
const USER_ANSWER_SOURCES = ["user-reply", "os-inbox"] as const;
/** Hard ceiling on the questions one call scans. */
export const REPLY_EXAMPLE_CANDIDATE_LIMIT = 200;
/** Characters kept from the end of the agent message. */
export const REPLY_EXAMPLE_AGENT_TAIL_CHARS = 600;
/** Characters kept from the start of the user's answer. */
export const REPLY_EXAMPLE_REPLY_CHARS = 400;

export interface ListReplyExamplesParams {
	orgId: string;
	/** The user whose answers are the examples (the questions' target). */
	targetUserId: string;
	/** Preferred repository: its examples sort first within the window. */
	repository?: string | null;
	/** The question being drafted for; never its own example. */
	excludeInteractionId: string;
	/** Examples returned; clamped to {@link REPLY_EXAMPLE_CANDIDATE_LIMIT}. */
	limit: number;
}

export interface ReplyExampleResult {
	interactionId: string;
	createdAt: string;
	repository: string | null;
	/** The last {@link REPLY_EXAMPLE_AGENT_TAIL_CHARS} characters of the question prompt. */
	agentTail: string;
	/** The first {@link REPLY_EXAMPLE_REPLY_CHARS} characters of the user's answer. */
	replyBody: string;
	replyClass: string | null;
	/** `accepted` / `edited` / `replaced` when the answer cited a tedi draft. */
	draftOutcome: string | null;
	source: string;
}

type ReplyExampleRow = {
	interaction_id: string;
	created_at: string;
	repository: string | null;
	agent_tail: string;
	reply_body: string;
	reply_class: string | null;
	draft_outcome: string | null;
	answer_source: string;
};

/**
 * Recent answered decision-capture questions of one user, newest window
 * first: the {@link REPLY_EXAMPLE_CANDIDATE_LIMIT} most recent resolved
 * questions (served by `idx_work_interactions_target_status`) joined to their
 * resolving answer by the target user. Within that window, the preferred
 * repository comes first, then answers that edited or replaced a tedi draft,
 * then recency.
 */
export async function listReplyExamples(
	db: DbQueryClient,
	p: ListReplyExamplesParams,
): Promise<ReplyExampleResult[]> {
	const limit = Math.min(
		Math.max(Math.trunc(p.limit), 0),
		REPLY_EXAMPLE_CANDIDATE_LIMIT,
	);
	if (limit === 0) return [];
	const repository = p.repository ?? null;
	const q = db
		.select({
			id: workInteractions.id,
			orgId: workInteractions.orgId,
			targetId: workInteractions.targetId,
			createdAt: workInteractions.createdAt,
			prompt: workInteractions.prompt,
			metadata: workInteractions.metadata,
		})
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.orgId, p.orgId),
				eq(workInteractions.targetType, "user"),
				eq(workInteractions.targetId, p.targetUserId),
				eq(workInteractions.status, "resolved"),
				eq(workInteractions.kind, "question"),
				ne(workInteractions.id, p.excludeInteractionId),
				sql`json_extract(${workInteractions.metadata}, '$.schema') = ${DECISION_CAPTURE_SCHEMA}`,
			),
		)
		.orderBy(desc(workInteractions.createdAt), desc(workInteractions.id))
		.limit(REPLY_EXAMPLE_CANDIDATE_LIMIT)
		.as("q");
	const r = workInteractionResponses;
	const rows: ReplyExampleRow[] = await db
		.select({
			interaction_id: q.id,
			created_at: q.createdAt,
			repository: sql<
				string | null
			>`json_extract(${q.metadata}, '$.repository')`.as("repository"),
			agent_tail:
				sql<string>`substr(${q.prompt}, -${REPLY_EXAMPLE_AGENT_TAIL_CHARS})`.as(
					"agent_tail",
				),
			reply_body:
				sql<string>`substr(${r.body}, 1, ${REPLY_EXAMPLE_REPLY_CHARS})`.as(
					"reply_body",
				),
			reply_class: sql<
				string | null
			>`json_extract(${r.metadata}, '$.replyClass')`.as("reply_class"),
			draft_outcome: sql<
				string | null
			>`json_extract(${r.metadata}, '$.draftOutcome')`.as("draft_outcome"),
			answer_source: sql<string>`json_extract(${r.metadata}, '$.source')`.as(
				"answer_source",
			),
		})
		.from(q)
		.innerJoin(
			r,
			and(
				eq(r.orgId, q.orgId),
				eq(r.interactionId, q.id),
				eq(r.resolvesRequest, true),
				eq(r.responderType, "user"),
				eq(r.responderId, q.targetId),
			),
		)
		.where(
			and(
				inArray(sql`json_extract(${r.metadata}, '$.source')`, [
					...USER_ANSWER_SOURCES,
				]),
				sql`coalesce(json_extract(${r.metadata}, '$.draftOutcome'), '') <> 'auto-sent'`,
				sql`length(trim(${r.body})) > 0`,
			),
		)
		.orderBy(
			sql`CASE WHEN ${repository} IS NOT NULL AND json_extract(${q.metadata}, '$.repository') = ${repository} THEN 0 ELSE 1 END`,
			sql`CASE WHEN json_extract(${r.metadata}, '$.draftOutcome') IN ('replaced', 'edited') THEN 0 ELSE 1 END`,
			desc(q.createdAt),
			desc(q.id),
		)
		.limit(limit);
	return rows.map((row) => ({
		interactionId: row.interaction_id,
		createdAt: row.created_at,
		repository: typeof row.repository === "string" ? row.repository : null,
		agentTail: row.agent_tail,
		replyBody: row.reply_body,
		replyClass: typeof row.reply_class === "string" ? row.reply_class : null,
		draftOutcome:
			typeof row.draft_outcome === "string" ? row.draft_outcome : null,
		source: row.answer_source,
	}));
}
