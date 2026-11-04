import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { humanReservedActionClasses } from "@tedix/api-contract/utils/approval-policy";
import type { DbQueryClient } from "../../query-client";
import { workItemComments, workItemRelations } from "../../schema/work-items";
import {
	workInteractionResponses,
	workInteractions,
} from "../../schema/work-factory";
import { getWorkItemById } from "./crud";
import { decisionRelevantWorkComment } from "./comments";
import {
	decisionSourcesReview,
	DECISION_SOURCE_CHANGED,
} from "./decision-sources";

type Decision = {
	creatorType?: string;
	creatorId?: string;
	id: string;
	workItemId: string | null;
	createdAt: string;
	status: string;
	kind: string;
	targetType: string | null;
	targetId: string | null;
	subject: string;
	prompt: string;
	metadata: Record<string, unknown>;
};

export type DecisionActionChange = {
	text: string;
	/**
	 * Set only for a newer Work comment: the person may read it and answer
	 * against it. Passing this time back as `reviewedThrough` binds the answer
	 * to that version; anything newer still blocks it.
	 */
	reviewableThrough?: string;
	/** Bounded comment text, for the person to read before answering. */
	note?: string;
};

/** An answer is evidence of a choice, never a durable grant over changed facts. */
export async function decisionActionChange(
	db: DbQueryClient,
	orgId: string,
	request: Decision,
	options: { reviewedThrough?: string } = {},
): Promise<string | null> {
	return (
		(await decisionActionChangeDetail(db, orgId, request, options))?.text ??
		null
	);
}

/** The time a resolving answer said its person had read the Work through. */
async function answeredReviewThrough(
	db: DbQueryClient,
	orgId: string,
	requestId: string,
) {
	const [row] = await db
		.select({
			reviewedThrough: sql<
				string | null
			>`json_extract(${workInteractionResponses.metadata}, '$.reviewedChangesThrough')`,
		})
		.from(workInteractionResponses)
		.where(
			and(
				eq(workInteractionResponses.orgId, orgId),
				eq(workInteractionResponses.interactionId, requestId),
				eq(workInteractionResponses.resolvesRequest, true),
			),
		)
		.orderBy(desc(workInteractionResponses.respondedAt))
		.limit(1);
	return typeof row?.reviewedThrough === "string"
		? row.reviewedThrough
		: undefined;
}

export async function decisionActionChangeDetail(
	db: DbQueryClient,
	orgId: string,
	request: Decision,
	options: { reviewedThrough?: string } = {},
): Promise<DecisionActionChange | null> {
	const text = (value: string | null) => (value ? { text: value } : null);
	if (request.targetType !== "user" || request.kind === "coordination")
		return null;
	const envelope = DecisionEnvelopeSchema.safeParse(
		request.metadata.decisionDeck,
	);
	const protectedAction =
		humanReservedActionClasses(`${request.subject}\n${request.prompt}`).length >
			0 ||
		(envelope.success &&
			(envelope.data.reversibility === "one_way" ||
				envelope.data.protectedEffects.length > 0 ||
				envelope.data.options.some(
					(option) =>
						option.effect?.kind === "publish_docs" ||
						option.effect?.kind === "publish_support",
				)));
	if (!protectedAction) return null;
	const reviewedThrough =
		options.reviewedThrough ??
		(request.status === "resolved"
			? await answeredReviewThrough(db, orgId, request.id)
			: undefined);
	if (request.workItemId) {
		const work = await getWorkItemById(db, request.workItemId, orgId);
		if (!work) return text("The linked Work is no longer available.");
		if (work.disposition === "completed" || work.disposition === "cancelled")
			return text(`The linked Work is now ${work.disposition}.`);
		const [replacement] = await db
			.select({ id: workItemRelations.fromWorkItemId })
			.from(workItemRelations)
			.where(
				and(
					eq(workItemRelations.orgId, orgId),
					eq(workItemRelations.toWorkItemId, work.id),
					eq(workItemRelations.relationType, "supersedes"),
				),
			)
			.limit(1);
		if (replacement)
			return text(`The linked Work was superseded by ${replacement.id}.`);
		const since =
			reviewedThrough && reviewedThrough > request.createdAt
				? reviewedThrough
				: request.createdAt;
		const [comment] = await db
			.select({
				body: workItemComments.body,
				createdAt: workItemComments.createdAt,
			})
			.from(workItemComments)
			.where(
				and(
					eq(workItemComments.orgId, orgId),
					eq(workItemComments.workItemId, work.id),
					gt(workItemComments.createdAt, since),
					decisionRelevantWorkComment(request),
				),
			)
			.orderBy(desc(workItemComments.createdAt), desc(workItemComments.id))
			.limit(1);
		if (comment)
			return {
				text: `The linked Work has a newer comment: ${comment.body.slice(0, 2000)}`,
				reviewableThrough: comment.createdAt,
				note: comment.body.slice(0, 600),
			};
	}
	const subject = request.metadata.cardSubject;
	const subjectName =
		subject &&
		typeof subject === "object" &&
		"name" in subject &&
		typeof subject.name === "string"
			? subject.name
			: null;
	const [newer] = await db
		.select({ id: workInteractions.id })
		.from(workInteractions)
		.where(
			and(
				eq(workInteractions.orgId, orgId),
				eq(workInteractions.targetType, "user"),
				request.targetId
					? eq(workInteractions.targetId, request.targetId)
					: undefined,
				gt(workInteractions.createdAt, request.createdAt),
				// The facts-changed review this card raised is not a rival card.
				sql`coalesce(json_extract(${workInteractions.metadata}, '$.replacesDecisionId'), '')<>${request.id}`,
				or(
					request.workItemId
						? eq(workInteractions.workItemId, request.workItemId)
						: undefined,
					eq(workInteractions.subject, request.subject),
					subjectName
						? sql`json_extract(${workInteractions.metadata}, '$.cardSubject.name')=${subjectName}`
						: undefined,
				),
			),
		)
		.orderBy(desc(workInteractions.createdAt))
		.limit(1);
	if (newer)
		return text(`A newer card (${newer.id}) concerns the same subject.`);
	// Resolved answers need the same source comparison as an open card.
	const sources = await decisionSourcesReview(
		db,
		orgId,
		{ ...request, status: "open" },
		{ reviewedThrough },
	);
	if (sources.current) return null;
	return sources.reviewable
		? {
				text: `${DECISION_SOURCE_CHANGED} ${sources.reviewable.note}`,
				reviewableThrough: sources.reviewable.through,
				note: sources.reviewable.note,
			}
		: text(DECISION_SOURCE_CHANGED);
}
