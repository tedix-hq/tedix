/**
 * Tedi-drafted replies to a human's open decision-capture question.
 *
 * Drafts are append-only proposals (`work_interaction_reply_drafts`); the
 * migration's insert guard admits a draft only for an open, quiet
 * (`triage.status = ok`, `urgency = later`, no urgent labels) user-targeted
 * decision-capture question and an active drafter tedi in the same
 * organization. A draft never answers anything: the human answers through
 * `work_interaction_responses` and cites the draft in response metadata as
 * `{ draftId, draftOutcome: "accepted" | "edited" | "replaced", editRatio }`,
 * which is what acceptance is measured from.
 *
 * `delivery` is decided by the API at insert: `review` (default) waits for
 * the human; `auto` may be sent without review under the turn-triage
 * `autoSend` guardrails, whose per-session budget is
 * {@link countConsecutiveAutoReplies}. Once a client has delivered an auto
 * draft to the asking session, {@link recordAutoReplyDelivery} answers the
 * question in the drafting tedi's name (`draftOutcome: "auto"`) so it leaves
 * the user's inbox; the user may still correct it (`metadata.corrects`).
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import {
	decisionSourcesCurrent,
	DECISION_SOURCE_CHANGED,
} from "./decision-sources";
import { recordPersistedCardResolutionEdges } from "../decision-graph-writers";
import {
	and,
	asc,
	desc,
	eq,
	exists,
	gt,
	gte,
	inArray,
	isNotNull,
	lt,
	ne,
	notExists,
	notInArray,
	or,
	sql,
} from "drizzle-orm";
import { alias } from "drizzle-orm/sqlite-core";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkInteractionDeliveryVia,
	type WorkInteractionReplyDraft,
	type WorkInteractionResponse,
	type WorkInteractionTargetType,
	workInteractionDeliveries,
	workInteractionReplyDrafts,
	workInteractionResponses,
	workInteractions,
} from "../../schema/work-factory";
import { WorkControlError } from "./factory-validation";
import { competencyObservations } from "../../schema/earned-delegation";
import { tedis } from "../../schema/tedis";

/** Response `metadata.source` of an auto draft answering in the tedi's name. */
export const AUTO_REPLY_SOURCE = "auto-reply";

export const REPLY_DRAFT_OUTCOMES = ["accepted", "edited", "replaced"] as const;
export type ReplyDraftOutcome = (typeof REPLY_DRAFT_OUTCOMES)[number];

export const REPLY_DRAFT_DELIVERIES = ["review", "auto"] as const;
export type ReplyDraftDelivery = (typeof REPLY_DRAFT_DELIVERIES)[number];

const DECISION_CAPTURE_SCHEMA = "tedix.decision-capture.v1";
/** Turn type of a steering draft (`AGENT_REPLY_STEER_TURN_TYPE`). */
const STEER_TURN_TYPE = "steer";
/** Response `metadata.source` of an answer the user typed to their agent. */
const USER_REPLY_SOURCE = "user-reply";
/**
 * User `replyClass` values that follow an auto-sent reply rather than
 * redirect it. Any other class (or a missing one) on the user's follow-up
 * counts as an override.
 */
export const AUTO_REPLY_FOLLOW_CLASSES = [
	"continue",
	"approve",
	"ship",
	"fan-out",
] as const;

/**
 * User `replyClass` values that neither follow nor redirect an auto-sent
 * reply: a question about it ("what did the tedi suggest?") is not an override.
 */
export const AUTO_REPLY_NEUTRAL_CLASSES = ["question"] as const;

export interface InsertReplyDraftParams {
	id: string;
	orgId: string;
	interactionId: string;
	drafterId: string;
	body: string;
	rationale: string;
	turnType?: string | null;
	/** Defaults to `review`. */
	delivery?: ReplyDraftDelivery;
	/** Delivery-gate audit (JSON); null when the gate was not reached. */
	gate?: Record<string, JsonValue> | null;
	now: string;
}

/** Trigger messages from the reply-draft insert guard, mapped to stable codes. */
function translateDraftInsertError(error: unknown): never {
	// Drizzle wraps the driver error; the trigger message sits on the cause chain.
	const messages: string[] = [];
	for (
		let current: unknown = error, depth = 0;
		current && depth < 5;
		current = current instanceof Error ? current.cause : undefined, depth++
	)
		messages.push(current instanceof Error ? current.message : String(current));
	const message = messages.join("\n");
	if (
		message.includes("reply draft request is not an open quiet human question")
	)
		throw new WorkControlError(
			"NOT_ELIGIBLE",
			"Work interaction is not an open, non-urgent decision-capture question for a user",
		);
	if (message.includes("reply drafter is not an active tedi"))
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"Reply drafter is not an active tedi in the organization",
		);
	throw error;
}

export async function insertReplyDraft(
	db: DbQueryClient,
	p: InsertReplyDraftParams,
): Promise<WorkInteractionReplyDraft> {
	try {
		const [row] = await db
			.insert(workInteractionReplyDrafts)
			.values({
				id: p.id,
				orgId: p.orgId,
				interactionId: p.interactionId,
				drafterType: "tedi",
				drafterId: p.drafterId,
				body: p.body,
				rationale: p.rationale,
				turnType: p.turnType ?? null,
				delivery: p.delivery ?? "review",
				gate: p.gate ?? null,
				createdAt: p.now,
			})
			.returning();
		if (!row) throw new Error("Reply draft insert returned no row");
		return row;
	} catch (error) {
		translateDraftInsertError(error);
	}
}

export interface GetLatestReplyDraftParams {
	orgId: string;
	interactionId: string;
}

/** One bounded read per inbox page, rather than a detail round trip per card. */
export async function listLatestReplyDrafts(
	db: DbQueryClient,
	orgId: string,
	interactionIds: string[],
) {
	const rows: WorkInteractionReplyDraft[] = [];
	for (let offset = 0; offset < interactionIds.length; offset += 50) {
		rows.push(
			...(await db
				.select()
				.from(workInteractionReplyDrafts)
				.where(
					and(
						eq(workInteractionReplyDrafts.orgId, orgId),
						inArray(
							workInteractionReplyDrafts.interactionId,
							interactionIds.slice(offset, offset + 50),
						),
						sql`${workInteractionReplyDrafts.id} = (SELECT latest.id FROM work_interaction_reply_drafts latest WHERE latest.org_id = ${orgId} AND latest.interaction_id = ${workInteractionReplyDrafts.interactionId} ORDER BY latest.created_at DESC, latest.id DESC LIMIT 1)`,
					),
				)),
		);
	}
	return rows;
}

export async function getLatestReplyDraft(
	db: DbQueryClient,
	p: GetLatestReplyDraftParams,
): Promise<WorkInteractionReplyDraft | null> {
	const [row] = await db
		.select()
		.from(workInteractionReplyDrafts)
		.where(
			and(
				eq(workInteractionReplyDrafts.orgId, p.orgId),
				eq(workInteractionReplyDrafts.interactionId, p.interactionId),
			),
		)
		.orderBy(
			desc(workInteractionReplyDrafts.createdAt),
			desc(workInteractionReplyDrafts.id),
		)
		.limit(1);
	return row ?? null;
}

export interface CountConsecutiveAutoRepliesParams {
	orgId: string;
	/** The question being drafted for; it is never counted itself. */
	interactionId: string;
	/** The question's target user. */
	targetUserId: string;
	/** The question's `metadata.sessionId`. */
	sessionId: string;
	/** The question's `created_at`: only earlier questions are counted. */
	createdAt: string;
	/** Stop counting here; the caller only compares against this budget. */
	limit: number;
}

type ConsecutiveRow = { has_auto: number; user_replied: number };

/**
 * The per-session auto-send budget in use: walks the session's earlier
 * decision-capture questions (same org, target user, `metadata.sessionId`),
 * newest first, excluding `interactionId`, and counts while a question has an
 * `auto` draft and no `user-reply` answer from the target user. The walk stops
 * at the first question the user answered themselves or that has no auto
 * draft, so a user reply resets the budget. Reads at most `limit` rows.
 */
export async function countConsecutiveAutoReplies(
	db: DbQueryClient,
	p: CountConsecutiveAutoRepliesParams,
): Promise<number> {
	if (p.limit <= 0) return 0;
	const d = alias(workInteractionReplyDrafts, "d");
	const r = alias(workInteractionResponses, "r");
	const rows: ConsecutiveRow[] = await db
		.select({
			has_auto: sql<number>`${exists(
				db
					.select({ one: sql`1` })
					.from(d)
					.where(
						and(
							eq(d.orgId, q.orgId),
							eq(d.interactionId, q.id),
							eq(d.delivery, "auto"),
						),
					),
			)}`.as("has_auto"),
			user_replied: sql<number>`${exists(
				db
					.select({ one: sql`1` })
					.from(r)
					.where(
						and(
							eq(r.orgId, q.orgId),
							eq(r.interactionId, q.id),
							eq(r.responderType, "user"),
							eq(r.responderId, p.targetUserId),
							sql`json_extract(${r.metadata}, '$.source') = ${USER_REPLY_SOURCE}`,
						),
					),
			)}`.as("user_replied"),
		})
		.from(q)
		.where(earlierSessionQuestions(p))
		.orderBy(desc(q.createdAt), desc(q.id))
		.limit(p.limit);
	let count = 0;
	for (const row of rows) {
		if (!Number(row.has_auto) || Number(row.user_replied)) break;
		count++;
	}
	return count;
}

export interface GetPreviousSessionDraftTurnTypeParams {
	orgId: string;
	/** The current question; only questions before it count. */
	interactionId: string;
	targetUserId: string;
	sessionId: string;
	createdAt: string;
}

/**
 * The turn type of the latest draft on the session's decision-capture question
 * just before `interactionId` (same org, target user and `metadata.sessionId`);
 * null when there is no earlier question, it has no draft, or no turn type.
 */
export async function getPreviousSessionDraftTurnType(
	db: DbQueryClient,
	p: GetPreviousSessionDraftTurnTypeParams,
): Promise<string | null> {
	const d = alias(workInteractionReplyDrafts, "d");
	const [row] = await db
		.select({
			turn_type: sql<string | null>`${db
				.select({ turnType: d.turnType })
				.from(d)
				.where(and(eq(d.orgId, q.orgId), eq(d.interactionId, q.id)))
				.orderBy(desc(d.createdAt), desc(d.id))
				.limit(1)}`.as("turn_type"),
		})
		.from(q)
		.where(earlierSessionQuestions(p))
		.orderBy(desc(q.createdAt), desc(q.id))
		.limit(1);
	return row?.turn_type ?? null;
}

const q = alias(workInteractions, "q");

/** The session's decision-capture questions before the current one. */
function earlierSessionQuestions(p: GetPreviousSessionDraftTurnTypeParams) {
	return and(
		eq(q.orgId, p.orgId),
		eq(q.targetType, "user"),
		eq(q.targetId, p.targetUserId),
		eq(q.kind, "question"),
		ne(q.id, p.interactionId),
		sql`json_extract(${q.metadata}, '$.schema') = ${DECISION_CAPTURE_SCHEMA}`,
		sql`json_extract(${q.metadata}, '$.sessionId') = ${p.sessionId}`,
		or(
			lt(q.createdAt, p.createdAt),
			and(eq(q.createdAt, p.createdAt), lt(q.id, p.interactionId)),
		),
	);
}

export interface GetReplyDraftAcceptanceParams {
	orgId: string;
	/** The human whose questions were drafted for (the interaction target). */
	targetUserId: string;
	/** Inclusive lower bound on draft creation time (ISO-8601). */
	since?: string;
}

export interface ReplyDraftAcceptanceOptions {
	minRate: number;
	minDrafts: number;
}

export interface ReplyDraftAcceptanceResult {
	turnType: string | null;
	/** Every draft proposed for this turn type. */
	drafts: number;
	/** Drafts the target user answered with, citing the draft. */
	decided: number;
	accepted: number;
	edited: number;
	replaced: number;
	/** accepted / decided; 0 when nothing is decided. */
	rate: number;
	/** decided ≥ minDrafts and rate ≥ minRate. */
	eligible: boolean;
	/** Drafts with `delivery = auto`. */
	autoSent: number;
	/** Auto drafts the user followed up on (a `user-reply` answer). */
	autoFollowedUp: number;
	/**
	 * Auto drafts whose user follow-up was neither a follow nor a neutral
	 * class, or that the agent's next turn declined (`priorDraft` rejected).
	 */
	overridden: number;
	/** overridden / autoSent; 0 when nothing was auto-sent. */
	overrideRate: number;
}

type AcceptanceRow = {
	turn_type: string | null;
	draft_count: number;
	accepted_count: number;
	edited_count: number;
	replaced_count: number;
	auto_count: number;
	auto_followed_count: number;
	overridden_count: number;
};

/**
 * An auto draft the agent declined, or whose follow-up was neither a follow
 * nor a neutral class.
 */
function overriddenDraft(o: DraftOutcomeRows) {
	return sql`(${o.rejected} = 1 OR (${o.followup} IS NOT NULL AND ${notInArray(o.followup, [...AUTO_REPLY_FOLLOW_CLASSES])} AND ${notInArray(o.followup, [...AUTO_REPLY_NEUTRAL_CLASSES])}))`;
}

/** Narrows {@link draftOutcomes}; an omitted field does not filter. */
interface DraftOutcomeScope {
	orgId?: string;
	targetUserId?: string;
	since?: string;
}

/**
 * One row per draft for the target user's questions created at or after
 * `since`: its outcome (the earliest citing answer's `draftOutcome`), delivery,
 * auto follow-up `replyClass`, whether the agent declined it, its drafter and
 * how long after the question it landed (`reply_seconds`).
 */
function draftOutcomes(db: DbQueryClient, p: DraftOutcomeScope) {
	const since = p.since ?? null;
	const orgId = p.orgId ?? null;
	const targetUserId = p.targetUserId ?? null;
	const d = alias(workInteractionReplyDrafts, "d");
	const i = alias(workInteractions, "i");
	const r = alias(workInteractionResponses, "r");
	const u = alias(workInteractionResponses, "u");
	const n = alias(workInteractions, "n");
	const outcome = db
		.select({ outcome: sql`json_extract(${r.metadata}, '$.draftOutcome')` })
		.from(r)
		.where(
			and(
				eq(r.orgId, d.orgId),
				eq(r.interactionId, d.interactionId),
				eq(r.responderType, "user"),
				eq(r.responderId, i.targetId),
				sql`json_extract(${r.metadata}, '$.draftId') = ${d.id}`,
			),
		)
		.orderBy(asc(r.respondedAt), asc(r.id))
		.limit(1);
	const nextSessionQuestion = db
		.select({ id: n.id })
		.from(n)
		.where(
			and(
				eq(n.orgId, i.orgId),
				eq(n.targetType, "user"),
				eq(n.targetId, i.targetId),
				eq(n.kind, "question"),
				sql`json_extract(${n.metadata}, '$.schema') = ${DECISION_CAPTURE_SCHEMA}`,
				sql`json_extract(${n.metadata}, '$.sessionId') = json_extract(${i.metadata}, '$.sessionId')`,
				or(
					gt(n.createdAt, i.createdAt),
					and(eq(n.createdAt, i.createdAt), gt(n.id, i.id)),
				),
			),
		)
		.orderBy(asc(n.createdAt), asc(n.id))
		.limit(1);
	const followup = db
		.select({
			replyClass: sql`coalesce(json_extract(${u.metadata}, '$.replyClass'), '')`,
		})
		.from(u)
		.where(
			and(
				eq(u.orgId, d.orgId),
				eq(u.responderType, "user"),
				eq(u.responderId, i.targetId),
				sql`(json_extract(${u.metadata}, '$.source') = ${USER_REPLY_SOURCE} OR json_extract(${u.metadata}, '$.corrects') IS NOT NULL)`,
				sql`${u.interactionId} IN (${d.interactionId}, ${nextSessionQuestion})`,
			),
		)
		.orderBy(asc(u.respondedAt), asc(u.id))
		.limit(1);
	const declined = db
		.select({ one: sql`1` })
		.from(n)
		.where(
			and(
				eq(n.orgId, i.orgId),
				eq(n.targetType, "user"),
				eq(n.targetId, i.targetId),
				eq(n.kind, "question"),
				sql`json_extract(${n.metadata}, '$.priorDraft.draftId') = ${d.id}`,
				sql`json_extract(${n.metadata}, '$.priorDraft.draftOutcome') = 'rejected'`,
			),
		);
	return db
		.select({
			draftId: sql<string>`${d.id}`.as("draft_id"),
			orgId: sql<string>`${d.orgId}`.as("org_id"),
			targetId: sql<string>`${i.targetId}`.as("target_id"),
			turnType: sql<string | null>`${d.turnType}`.as("turn_type"),
			drafterId: sql<string>`${d.drafterId}`.as("drafter_id"),
			createdAt: sql<string>`${d.createdAt}`.as("created_at"),
			replySeconds:
				sql<number>`(julianday(${d.createdAt}) - julianday(${i.createdAt})) * 86400`.as(
					"reply_seconds",
				),
			outcome: sql<string | null>`${outcome}`.as("outcome"),
			delivery: sql<ReplyDraftDelivery>`${d.delivery}`.as("delivery"),
			followup: sql<
				string | null
			>`CASE WHEN ${d.delivery} = 'auto' THEN ${followup} END`.as("followup"),
			rejected:
				sql<number>`CASE WHEN ${d.delivery} = 'auto' THEN ${exists(declined)} ELSE 0 END`.as(
					"rejected",
				),
		})
		.from(d)
		.innerJoin(i, and(eq(i.orgId, d.orgId), eq(i.id, d.interactionId)))
		.where(
			and(
				sql`(${orgId} IS NULL OR ${d.orgId} = ${orgId})`,
				eq(i.targetType, "user"),
				sql`(${targetUserId} IS NULL OR ${i.targetId} = ${targetUserId})`,
				sql`(${since} IS NULL OR ${d.createdAt} >= ${since})`,
			),
		);
}

type DraftOutcomeRows = ReturnType<ReturnType<typeof draftOutcomes>["as"]>;

/**
 * Draft acceptance per turn type for one target user. A draft's outcome is the
 * `draftOutcome` of the earliest response by that user citing the draft id;
 * drafts nobody answered with count toward `drafts` but not `decided`, so an
 * ignored draft can never earn eligibility.
 *
 * An `auto` draft's follow-up is the earliest `user-reply` answer (or a
 * correction of the tedi's auto reply, `metadata.corrects`) by the target
 * user on its own question or on the session's next decision-capture
 * question (same target user and `metadata.sessionId`, created after it). It
 * is overridden when that answer's `replyClass` is missing or not one of
 * {@link AUTO_REPLY_FOLLOW_CLASSES} or {@link AUTO_REPLY_NEUTRAL_CLASSES}. It
 * is also overridden when the agent's next turn declined it: a later question
 * carries `metadata.priorDraft` {draftId, draftOutcome: "rejected"}, written
 * by the capture hook as agent-sourced, not as the user's answer.
 */
export async function getReplyDraftAcceptance(
	db: DbQueryClient,
	p: GetReplyDraftAcceptanceParams,
	options: ReplyDraftAcceptanceOptions,
): Promise<ReplyDraftAcceptanceResult[]> {
	const outcomes = draftOutcomes(db, p).as("outcomes");
	const draftCount = sql<number>`count(*)`.as("draft_count");
	const rows: AcceptanceRow[] = await db
		.select({
			turn_type: outcomes.turnType,
			draft_count: draftCount,
			accepted_count:
				sql<number>`sum(CASE WHEN ${outcomes.outcome} = 'accepted' THEN 1 ELSE 0 END)`.as(
					"accepted_count",
				),
			edited_count:
				sql<number>`sum(CASE WHEN ${outcomes.outcome} = 'edited' THEN 1 ELSE 0 END)`.as(
					"edited_count",
				),
			replaced_count:
				sql<number>`sum(CASE WHEN ${outcomes.outcome} = 'replaced' THEN 1 ELSE 0 END)`.as(
					"replaced_count",
				),
			auto_count:
				sql<number>`sum(CASE WHEN ${outcomes.delivery} = 'auto' THEN 1 ELSE 0 END)`.as(
					"auto_count",
				),
			auto_followed_count:
				sql<number>`sum(CASE WHEN ${outcomes.followup} IS NOT NULL THEN 1 ELSE 0 END)`.as(
					"auto_followed_count",
				),
			overridden_count:
				sql<number>`sum(CASE WHEN ${overriddenDraft(outcomes)} THEN 1 ELSE 0 END)`.as(
					"overridden_count",
				),
		})
		.from(outcomes)
		.groupBy(outcomes.turnType)
		.orderBy(desc(sql`draft_count`), asc(outcomes.turnType));
	return rows.map((row) => {
		const accepted = Number(row.accepted_count ?? 0);
		const edited = Number(row.edited_count ?? 0);
		const replaced = Number(row.replaced_count ?? 0);
		const decided = accepted + edited + replaced;
		const rate = decided > 0 ? accepted / decided : 0;
		const autoSent = Number(row.auto_count ?? 0);
		const overridden = Number(row.overridden_count ?? 0);
		return {
			turnType: row.turn_type,
			drafts: Number(row.draft_count),
			decided,
			accepted,
			edited,
			replaced,
			rate,
			eligible: decided >= options.minDrafts && rate >= options.minRate,
			autoSent,
			autoFollowedUp: Number(row.auto_followed_count ?? 0),
			overridden,
			overrideRate: autoSent > 0 ? overridden / autoSent : 0,
		};
	});
}

export interface GetReplyDraftLeaderboardParams extends GetReplyDraftAcceptanceParams {
	since: string;
	/** Start of "today"; at or after `since`. */
	todaySince: string;
}

export interface ReplyDraftScore {
	/** Drafts the tedi wrote (each one answers a knock). */
	answered: number;
	/** Auto drafts sent without review. */
	autoSent: number;
	/** Auto drafts not overridden, plus review drafts accepted as written. */
	stood: number;
	/** Edited or replaced drafts, plus overridden auto drafts. */
	corrected: number;
	/** Steering drafts (turn type `steer`). */
	steered: number;
	/** Mean seconds from the question to the draft; null with no drafts. */
	avgReplySeconds: number | null;
}

export interface ReplyDraftLeaderboardResult {
	tediId: string;
	name: string;
	avatar: string | null;
	week: ReplyDraftScore;
	today: ReplyDraftScore;
}

type ScoreColumn =
	`${"w" | "t"}_${"answered" | "auto" | "stood" | "corrected" | "steered" | "reply_seconds"}`;
type LeaderboardRow = {
	drafter_id: string;
	tedi_name: string | null;
	tedi_avatar: string | null;
} & Record<ScoreColumn, number | null>;

/**
 * Per drafting tedi, how its replies to the target user's questions fared
 * since `since` and since `todaySince`, ranked by replies that stood. Uses the
 * same outcome rules as {@link getReplyDraftAcceptance}.
 */
export async function getReplyDraftLeaderboard(
	db: DbQueryClient,
	p: GetReplyDraftLeaderboardParams,
): Promise<ReplyDraftLeaderboardResult[]> {
	const o = draftOutcomes(db, p).as("o");
	const t = alias(tedis, "t");
	const overridden = overriddenDraft(o);
	const stood = sql`((${o.delivery} = 'auto' AND NOT ${overridden}) OR (${o.delivery} IS NOT 'auto' AND ${o.outcome} = 'accepted'))`;
	const corrected = sql`(${o.outcome} IN ('edited', 'replaced') OR (${o.delivery} = 'auto' AND ${overridden}))`;
	const today = sql`${o.createdAt} >= ${p.todaySince}`;
	const steered = sql`${o.turnType} = ${STEER_TURN_TYPE}`;
	const rows: LeaderboardRow[] = await db
		.select({
			drafter_id: o.drafterId,
			tedi_name: sql<string | null>`${t.name}`.as("tedi_name"),
			tedi_avatar: sql<string | null>`${t.avatar}`.as("tedi_avatar"),
			w_answered: sql<number>`count(*)`.as("w_answered"),
			w_auto:
				sql<number>`sum(CASE WHEN ${o.delivery} = 'auto' THEN 1 ELSE 0 END)`.as(
					"w_auto",
				),
			w_stood: sql<number>`sum(CASE WHEN ${stood} THEN 1 ELSE 0 END)`.as(
				"w_stood",
			),
			w_corrected:
				sql<number>`sum(CASE WHEN ${corrected} THEN 1 ELSE 0 END)`.as(
					"w_corrected",
				),
			w_steered: sql<number>`sum(CASE WHEN ${steered} THEN 1 ELSE 0 END)`.as(
				"w_steered",
			),
			w_reply_seconds: sql<number | null>`avg(${o.replySeconds})`.as(
				"w_reply_seconds",
			),
			t_answered: sql<number>`sum(CASE WHEN ${today} THEN 1 ELSE 0 END)`.as(
				"t_answered",
			),
			t_auto:
				sql<number>`sum(CASE WHEN ${today} AND ${o.delivery} = 'auto' THEN 1 ELSE 0 END)`.as(
					"t_auto",
				),
			t_stood:
				sql<number>`sum(CASE WHEN ${today} AND ${stood} THEN 1 ELSE 0 END)`.as(
					"t_stood",
				),
			t_corrected:
				sql<number>`sum(CASE WHEN ${today} AND ${corrected} THEN 1 ELSE 0 END)`.as(
					"t_corrected",
				),
			t_steered:
				sql<number>`sum(CASE WHEN ${today} AND ${steered} THEN 1 ELSE 0 END)`.as(
					"t_steered",
				),
			t_reply_seconds: sql<
				number | null
			>`avg(CASE WHEN ${today} THEN ${o.replySeconds} END)`.as(
				"t_reply_seconds",
			),
		})
		.from(o)
		.leftJoin(t, and(eq(t.id, o.drafterId), eq(t.organizationId, p.orgId)))
		.groupBy(o.drafterId)
		.orderBy(
			desc(sql`w_stood`),
			asc(sql`w_corrected`),
			desc(sql`w_answered`),
			asc(o.drafterId),
		)
		.limit(50);
	const score = (row: LeaderboardRow, at: "w" | "t"): ReplyDraftScore => {
		const seconds = row[`${at}_reply_seconds`];
		return {
			answered: Number(row[`${at}_answered`] ?? 0),
			autoSent: Number(row[`${at}_auto`] ?? 0),
			stood: Number(row[`${at}_stood`] ?? 0),
			corrected: Number(row[`${at}_corrected`] ?? 0),
			steered: Number(row[`${at}_steered`] ?? 0),
			avgReplySeconds:
				seconds === null ? null : Math.max(0, Math.round(Number(seconds))),
		};
	};
	return rows.map((row) => ({
		tediId: row.drafter_id,
		name: row.tedi_name ?? "Former tedi",
		avatar: row.tedi_avatar,
		week: score(row, "w"),
		today: score(row, "t"),
	}));
}

/** The tedi response an auto-delivered draft became, or null. */
export async function getAutoReplyResponse(
	db: DbQueryClient,
	p: { orgId: string; interactionId: string; draftId: string },
): Promise<WorkInteractionResponse | null> {
	const [row] = await db
		.select()
		.from(workInteractionResponses)
		.where(
			and(
				eq(workInteractionResponses.orgId, p.orgId),
				eq(workInteractionResponses.interactionId, p.interactionId),
				eq(workInteractionResponses.responderType, "tedi"),
				sql`json_extract(${workInteractionResponses.metadata},'$.draftId')=${p.draftId}`,
				sql`json_extract(${workInteractionResponses.metadata},'$.draftOutcome')='auto'`,
			),
		)
		.limit(1);
	return row ?? null;
}

export interface RecordAutoReplyDeliveryParams {
	orgId: string;
	interactionId: string;
	draftId: string;
	/** The caller: the question's asked user or its creator. */
	actor: { type: WorkInteractionTargetType; id: string };
	via: Exclude<WorkInteractionDeliveryVia, "legacy">;
	/** Id of the response when this call creates it. */
	responseId: string;
	now: string;
}

export interface AutoReplyDeliveryResult {
	response: WorkInteractionResponse;
	deliveredAt: string | null;
	deliveredVia: WorkInteractionDeliveryVia | null;
	/** False when an earlier call already recorded this draft. */
	created: boolean;
}

/**
 * An auto draft reached the asking session: answer the question in the
 * drafting tedi's name (`resolvesRequest`, `metadata.draftId`,
 * `draftOutcome: "auto"`) and record the delivery, in one batch. The
 * response-insert trigger admits only an `auto` draft of this question by
 * this tedi. Idempotent per draft: a repeat returns the stored response and
 * keeps the first delivery. A question answered meanwhile is a conflict.
 */
export async function recordAutoReplyDelivery(
	db: DbQueryClient,
	p: RecordAutoReplyDeliveryParams,
): Promise<AutoReplyDeliveryResult> {
	const [request] = await db
		.select()
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.orgId, p.orgId),
				eq(workInteractions.id, p.interactionId),
			),
		)
		.limit(1);
	if (!request)
		throw new WorkControlError("NOT_FOUND", "Work interaction not found");
	const owns =
		(request.targetType === p.actor.type && request.targetId === p.actor.id) ||
		(request.creatorType === p.actor.type && request.creatorId === p.actor.id);
	if (!owns)
		throw new WorkControlError(
			"INVALID_PRINCIPAL",
			"Only the question's asker or asked user records draft delivery",
		);
	const [draft] = await db
		.select()
		.from(workInteractionReplyDrafts)
		.where(
			and(
				eq(workInteractionReplyDrafts.orgId, p.orgId),
				eq(workInteractionReplyDrafts.interactionId, p.interactionId),
				eq(workInteractionReplyDrafts.id, p.draftId),
			),
		)
		.limit(1);
	if (!draft) throw new WorkControlError("NOT_FOUND", "Reply draft not found");
	if (draft.delivery !== "auto")
		throw new WorkControlError(
			"NOT_ELIGIBLE",
			"Only an auto reply draft answers in the tedi's name",
		);
	const existing = await getAutoReplyResponse(db, p);
	if (existing) {
		const [row] = await db
			.select()
			.from(workInteractionDeliveries)
			.where(
				and(
					eq(workInteractionDeliveries.orgId, p.orgId),
					eq(workInteractionDeliveries.responseId, existing.id),
				),
			)
			.limit(1);
		return {
			response: existing,
			deliveredAt: row?.deliveredAt ?? null,
			deliveredVia: row?.deliveredVia ?? null,
			created: false,
		};
	}
	if (request.status !== "open")
		throw new WorkControlError(
			"CONFLICT",
			"Question was answered before the draft was delivered",
		);
	if (!(await decisionSourcesCurrent(db, p.orgId, request)))
		throw new WorkControlError("CONFLICT", DECISION_SOURCE_CHANGED);
	const { sessionId, host } = request.metadata;
	try {
		const [responses, deliveries] = await db.batch([
			db
				.insert(workInteractionResponses)
				.values({
					id: p.responseId,
					orgId: p.orgId,
					interactionId: p.interactionId,
					resolvedRequestVersion: request.version + 1,
					resolutionFence: crypto.randomUUID(),
					responderType: "tedi",
					responderId: draft.drafterId,
					body: draft.body,
					responseKind: "answer",
					resolvesRequest: true,
					metadata: {
						source: AUTO_REPLY_SOURCE,
						draftId: draft.id,
						draftOutcome: "auto",
						...(typeof sessionId === "string" ? { sessionId } : {}),
						...(typeof host === "string" ? { host } : {}),
					},
					respondedAt: p.now,
				})
				.returning(),
			db
				.insert(workInteractionDeliveries)
				.values({
					orgId: p.orgId,
					responseId: p.responseId,
					interactionId: p.interactionId,
					deliveredAt: p.now,
					deliveredVia: p.via,
					acknowledgedAt: null,
					handoffTo: null,
					handoffRef: null,
					updatedAt: p.now,
				})
				.returning(),
		]);
		const response = responses[0];
		if (!response) throw new Error("lost race");
		await recordPersistedCardResolutionEdges(db, p.orgId, response.id);
		return {
			response,
			deliveredAt: deliveries[0]?.deliveredAt ?? p.now,
			deliveredVia: deliveries[0]?.deliveredVia ?? p.via,
			created: true,
		};
	} catch (error) {
		// Two clients delivering the same draft: the first record stands.
		const raced = await getAutoReplyResponse(db, p);
		if (raced)
			return {
				response: raced,
				deliveredAt: null,
				deliveredVia: null,
				created: false,
			};
		const cause = error instanceof Error ? error.message : String(error);
		throw new WorkControlError(
			"CONFLICT",
			`Auto reply was not recorded: ${cause}`,
		);
	}
}

/** The `client_observation_id` of a reply draft's competency observation. */
export function replyDraftObservationKey(draftId: string): string {
	return `reply-draft:${draftId}`;
}

/** Organizations with recent drafts, before applying their individual settlement policies. */
export async function listReplyDraftOutcomeOrganizations(
	db: DbQueryClient,
	since: string,
) {
	const rows = await db
		.selectDistinct({ orgId: workInteractionReplyDrafts.orgId })
		.from(workInteractionReplyDrafts)
		.where(
			and(
				gte(workInteractionReplyDrafts.createdAt, since),
				sql`NOT EXISTS (SELECT 1 FROM competency_observations c WHERE c.organization_id = ${workInteractionReplyDrafts.orgId} AND c.client_observation_id = 'reply-draft:' || ${workInteractionReplyDrafts.id})`,
			),
		)
		.orderBy(asc(workInteractionReplyDrafts.orgId));
	return rows.map((row) => row.orgId);
}

export interface ListUnrecordedReplyDraftOutcomesParams {
	orgId?: string;
	/** Drafts created at or after this instant. */
	since: string;
	/** An auto draft with no override created at or before this instant stood. */
	settledBefore: string;
	limit: number;
}

export interface SettledReplyDraftOutcome {
	orgId: string;
	draftId: string;
	drafterId: string;
	/** The human whose question it answered and who judged it. */
	targetUserId: string;
	createdAt: string;
	delivery: ReplyDraftDelivery;
	/** By the rules of {@link getReplyDraftLeaderboard}. */
	verdict: "stood" | "corrected";
}

type SettledRow = {
	org_id: string;
	draft_id: string;
	drafter_id: string;
	target_id: string;
	created_at: string;
	delivery: ReplyDraftDelivery;
	verdict: "stood" | "corrected";
};

/**
 * Settled reply drafts, across organizations, that have no competency
 * observation yet, oldest first, by the rules of
 * {@link getReplyDraftLeaderboard}: a review draft settles when its human
 * answers with it (accepted stood; edited or replaced was corrected). An auto
 * draft was corrected when overridden, and stood once followed without
 * override or, with no follow-up, once created at or before `settledBefore`.
 */
export async function listUnrecordedReplyDraftOutcomes(
	db: DbQueryClient,
	p: ListUnrecordedReplyDraftOutcomesParams,
): Promise<SettledReplyDraftOutcome[]> {
	const o = draftOutcomes(db, { since: p.since, orgId: p.orgId }).as("o");
	const t = alias(tedis, "t");
	const c = alias(competencyObservations, "c");
	const overridden = overriddenDraft(o);
	const settled = db
		.select({
			orgId: sql<string>`${o.orgId}`.as("org_id"),
			draftId: sql<string>`${o.draftId}`.as("draft_id"),
			drafterId: sql<string>`${o.drafterId}`.as("drafter_id"),
			targetId: sql<string>`${o.targetId}`.as("target_id"),
			createdAt: sql<string>`${o.createdAt}`.as("created_at"),
			delivery: sql<ReplyDraftDelivery>`${o.delivery}`.as("delivery"),
			verdict: sql<"stood" | "corrected" | null>`CASE
					WHEN ${o.delivery} = 'auto' AND ${overridden} THEN 'corrected'
					WHEN ${o.delivery} = 'auto' AND (${o.followup} IS NOT NULL OR ${o.createdAt} <= ${p.settledBefore}) THEN 'stood'
					WHEN ${o.delivery} IS NOT 'auto' AND ${o.outcome} = 'accepted' THEN 'stood'
					WHEN ${o.delivery} IS NOT 'auto' AND ${o.outcome} IN ('edited', 'replaced') THEN 'corrected'
				END`.as("verdict"),
		})
		.from(o)
		.where(
			and(
				exists(
					db
						.select({ one: sql`1` })
						.from(t)
						.where(and(eq(t.id, o.drafterId), eq(t.organizationId, o.orgId))),
				),
				notExists(
					db
						.select({ one: sql`1` })
						.from(c)
						.where(
							and(
								eq(c.organizationId, o.orgId),
								sql`${c.clientObservationId} = 'reply-draft:' || ${o.draftId}`,
							),
						),
				),
			),
		)
		.as("settled");
	const rows = (await db
		.select({
			org_id: settled.orgId,
			draft_id: settled.draftId,
			drafter_id: settled.drafterId,
			target_id: settled.targetId,
			created_at: settled.createdAt,
			delivery: settled.delivery,
			verdict: settled.verdict,
		})
		.from(settled)
		.where(isNotNull(settled.verdict))
		.orderBy(asc(settled.createdAt), asc(settled.draftId))
		.limit(p.limit)) as SettledRow[];
	return rows.map((row) => ({
		orgId: row.org_id,
		draftId: row.draft_id,
		drafterId: row.drafter_id,
		targetUserId: row.target_id,
		createdAt: row.created_at,
		delivery: row.delivery,
		verdict: row.verdict,
	}));
}
