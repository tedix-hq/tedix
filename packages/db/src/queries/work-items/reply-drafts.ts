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
 */

import { and, desc, eq, sql } from "drizzle-orm";
import type { DbQueryClient } from "../../query-client";
import {
	type WorkInteractionReplyDraft,
	workInteractionReplyDrafts,
} from "../../schema/work-factory";
import { WorkControlError } from "./factory-validation";

export const REPLY_DRAFT_OUTCOMES = ["accepted", "edited", "replaced"] as const;
export type ReplyDraftOutcome = (typeof REPLY_DRAFT_OUTCOMES)[number];

export interface InsertReplyDraftParams {
	id: string;
	orgId: string;
	interactionId: string;
	drafterId: string;
	body: string;
	rationale: string;
	turnType?: string | null;
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
}

type AcceptanceRow = {
	turn_type: string | null;
	draft_count: number;
	accepted_count: number;
	edited_count: number;
	replaced_count: number;
};

/**
 * Draft acceptance per turn type for one target user. A draft's outcome is the
 * `draftOutcome` of the earliest response by that user citing the draft id;
 * drafts nobody answered with count toward `drafts` but not `decided`, so an
 * ignored draft can never earn eligibility.
 */
export async function getReplyDraftAcceptance(
	db: DbQueryClient,
	p: GetReplyDraftAcceptanceParams,
	options: ReplyDraftAcceptanceOptions,
): Promise<ReplyDraftAcceptanceResult[]> {
	const since = p.since ?? null;
	const rows = await db.all<AcceptanceRow>(sql`
		SELECT
			outcomes.turn_type AS turn_type,
			count(*) AS draft_count,
			sum(CASE WHEN outcomes.outcome = 'accepted' THEN 1 ELSE 0 END) AS accepted_count,
			sum(CASE WHEN outcomes.outcome = 'edited' THEN 1 ELSE 0 END) AS edited_count,
			sum(CASE WHEN outcomes.outcome = 'replaced' THEN 1 ELSE 0 END) AS replaced_count
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
				) AS outcome
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
		return {
			turnType: row.turn_type,
			drafts: Number(row.draft_count),
			decided,
			accepted,
			edited,
			replaced,
			rate,
			eligible: decided >= options.minDrafts && rate >= options.minRate,
		};
	});
}
