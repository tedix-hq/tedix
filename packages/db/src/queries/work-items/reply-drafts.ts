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
 * {@link countConsecutiveAutoReplies}.
 */

import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkInteractionReplyDraft,
	workInteractionReplyDrafts,
} from "../../schema/work-factory";
import { WorkControlError } from "./factory-validation";

export const REPLY_DRAFT_OUTCOMES = ["accepted", "edited", "replaced"] as const;
export type ReplyDraftOutcome = (typeof REPLY_DRAFT_OUTCOMES)[number];

export const REPLY_DRAFT_DELIVERIES = ["review", "auto"] as const;
export type ReplyDraftDelivery = (typeof REPLY_DRAFT_DELIVERIES)[number];

const DECISION_CAPTURE_SCHEMA = "tedix.decision-capture.v1";
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
	const rows = await db.all<ConsecutiveRow>(sql`
		SELECT
			EXISTS(
				SELECT 1 FROM work_interaction_reply_drafts d
				WHERE d.org_id = q.org_id AND d.interaction_id = q.id AND d.delivery = 'auto'
			) AS has_auto,
			EXISTS(
				SELECT 1 FROM work_interaction_responses r
				WHERE r.org_id = q.org_id AND r.interaction_id = q.id
					AND r.responder_type = 'user' AND r.responder_id = ${p.targetUserId}
					AND json_extract(r.metadata, '$.source') = ${USER_REPLY_SOURCE}
			) AS user_replied
		FROM work_interactions q
		WHERE q.org_id = ${p.orgId}
			AND q.target_type = 'user'
			AND q.target_id = ${p.targetUserId}
			AND q.kind = 'question'
			AND q.id <> ${p.interactionId}
			AND json_extract(q.metadata, '$.schema') = ${DECISION_CAPTURE_SCHEMA}
			AND json_extract(q.metadata, '$.sessionId') = ${p.sessionId}
			AND (q.created_at < ${p.createdAt} OR (q.created_at = ${p.createdAt} AND q.id < ${p.interactionId}))
		ORDER BY q.created_at DESC, q.id DESC
		LIMIT ${p.limit}
	`);
	let count = 0;
	for (const row of rows) {
		if (!Number(row.has_auto) || Number(row.user_replied)) break;
		count++;
	}
	return count;
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
 * Draft acceptance per turn type for one target user. A draft's outcome is the
 * `draftOutcome` of the earliest response by that user citing the draft id;
 * drafts nobody answered with count toward `drafts` but not `decided`, so an
 * ignored draft can never earn eligibility.
 *
 * An `auto` draft's follow-up is the earliest `user-reply` answer by the
 * target user on its own question or on the session's next decision-capture
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
	const since = p.since ?? null;
	const followClasses = sql.join(
		AUTO_REPLY_FOLLOW_CLASSES.map((label) => sql`${label}`),
		sql`, `,
	);
	const neutralClasses = sql.join(
		AUTO_REPLY_NEUTRAL_CLASSES.map((label) => sql`${label}`),
		sql`, `,
	);
	const rows = await db.all<AcceptanceRow>(sql`
		SELECT
			outcomes.turn_type AS turn_type,
			count(*) AS draft_count,
			sum(CASE WHEN outcomes.outcome = 'accepted' THEN 1 ELSE 0 END) AS accepted_count,
			sum(CASE WHEN outcomes.outcome = 'edited' THEN 1 ELSE 0 END) AS edited_count,
			sum(CASE WHEN outcomes.outcome = 'replaced' THEN 1 ELSE 0 END) AS replaced_count,
			sum(CASE WHEN outcomes.delivery = 'auto' THEN 1 ELSE 0 END) AS auto_count,
			sum(CASE WHEN outcomes.followup IS NOT NULL THEN 1 ELSE 0 END) AS auto_followed_count,
			sum(CASE WHEN outcomes.rejected = 1 OR (outcomes.followup IS NOT NULL AND outcomes.followup NOT IN (${followClasses}) AND outcomes.followup NOT IN (${neutralClasses})) THEN 1 ELSE 0 END) AS overridden_count
		FROM (
			SELECT
				d.turn_type AS turn_type,
				(
					SELECT json_extract(r.metadata, '$.draftOutcome')
					FROM work_interaction_responses r
					WHERE r.org_id = d.org_id
						AND r.interaction_id = d.interaction_id
						AND r.responder_type = 'user'
						AND r.responder_id = ${p.targetUserId}
						AND json_extract(r.metadata, '$.draftId') = d.id
					ORDER BY r.responded_at, r.id
					LIMIT 1
				) AS outcome,
				d.delivery AS delivery,
				CASE WHEN d.delivery = 'auto' THEN (
					SELECT coalesce(json_extract(u.metadata, '$.replyClass'), '')
					FROM work_interaction_responses u
					WHERE u.org_id = d.org_id
						AND u.responder_type = 'user'
						AND u.responder_id = ${p.targetUserId}
						AND json_extract(u.metadata, '$.source') = ${USER_REPLY_SOURCE}
						AND u.interaction_id IN (
							d.interaction_id,
							(
								SELECT n.id FROM work_interactions n
								WHERE n.org_id = i.org_id
									AND n.target_type = 'user'
									AND n.target_id = i.target_id
									AND n.kind = 'question'
									AND json_extract(n.metadata, '$.schema') = ${DECISION_CAPTURE_SCHEMA}
									AND json_extract(n.metadata, '$.sessionId') = json_extract(i.metadata, '$.sessionId')
									AND (n.created_at > i.created_at OR (n.created_at = i.created_at AND n.id > i.id))
								ORDER BY n.created_at, n.id
								LIMIT 1
							)
						)
					ORDER BY u.responded_at, u.id
					LIMIT 1
				) END AS followup,
				CASE WHEN d.delivery = 'auto' THEN EXISTS (
					SELECT 1 FROM work_interactions n
					WHERE n.org_id = i.org_id
						AND n.target_type = 'user'
						AND n.target_id = i.target_id
						AND n.kind = 'question'
						AND json_extract(n.metadata, '$.priorDraft.draftId') = d.id
						AND json_extract(n.metadata, '$.priorDraft.draftOutcome') = 'rejected'
				) ELSE 0 END AS rejected
			FROM work_interaction_reply_drafts d
			JOIN work_interactions i ON i.org_id = d.org_id AND i.id = d.interaction_id
			WHERE d.org_id = ${p.orgId}
				AND i.target_type = 'user'
				AND i.target_id = ${p.targetUserId}
				AND (${since} IS NULL OR d.created_at >= ${since})
		) outcomes
		GROUP BY outcomes.turn_type
		ORDER BY draft_count DESC, outcomes.turn_type
	`);
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
