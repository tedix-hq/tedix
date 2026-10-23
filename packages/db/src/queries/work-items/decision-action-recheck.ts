import { and, desc, eq, gt, or, sql } from "drizzle-orm";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { humanReservedActionClasses } from "@tedix/api-contract/utils/approval-policy";
import type { DbQueryClient } from "../../query-client";
import { workItemComments, workItemRelations } from "../../schema/work-items";
import { workInteractions } from "../../schema/work-factory";
import { getWorkItemById } from "./crud";
import {
	decisionSourcesCurrent,
	DECISION_SOURCE_CHANGED,
} from "./decision-sources";

type Decision = {
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

/** An answer is evidence of a choice, never a durable grant over changed facts. */
export async function decisionActionChange(
	db: DbQueryClient,
	orgId: string,
	request: Decision,
): Promise<string | null> {
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
	if (request.workItemId) {
		const work = await getWorkItemById(db, request.workItemId, orgId);
		if (!work) return "The linked Work is no longer available.";
		if (work.disposition === "completed" || work.disposition === "cancelled")
			return `The linked Work is now ${work.disposition}.`;
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
			return `The linked Work was superseded by ${replacement.id}.`;
		const [comment] = await db
			.select({ body: workItemComments.body })
			.from(workItemComments)
			.where(
				and(
					eq(workItemComments.orgId, orgId),
					eq(workItemComments.workItemId, work.id),
					gt(workItemComments.createdAt, request.createdAt),
				),
			)
			.orderBy(desc(workItemComments.createdAt), desc(workItemComments.id))
			.limit(1);
		if (comment)
			return `The linked Work has a newer comment: ${comment.body.slice(0, 2000)}`;
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
	if (newer) return `A newer card (${newer.id}) concerns the same subject.`;
	// Resolved answers need the same source comparison as an open card.
	return (await decisionSourcesCurrent(db, orgId, {
		...request,
		status: "open",
	}))
		? null
		: DECISION_SOURCE_CHANGED;
}
