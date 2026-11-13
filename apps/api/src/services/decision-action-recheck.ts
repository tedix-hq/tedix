import { ORPCError } from "@orpc/server";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { decisionActionChangeDetail } from "@tedix/db/queries/work-items/decision-action-recheck";
import { retireDecisionReviews } from "@tedix/db/queries/work-items/decision-review-retirement";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import {
	createWorkInteraction,
	getWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";
import type { DbQueryClient } from "@tedix/db/query-client";

type Request = NonNullable<Awaited<ReturnType<typeof getWorkInteraction>>>;

/** Replace stale authority with a review of the changed facts, without copying any effect. */
export async function recheckDecisionAction(
	db: DbQueryClient,
	request: Request,
	now = new Date().toISOString(),
	reviewedThrough?: string,
) {
	if (!request.targetId) return null;
	const detail = await decisionActionChangeDetail(db, request.orgId, request, {
		reviewedThrough,
	});
	if (!detail) return null;
	const change = detail.text;
	const bytes = new Uint8Array(
		await crypto.subtle.digest(
			"SHA-256",
			new TextEncoder().encode(
				`decision-recheck:${request.orgId}:${request.id}`,
			),
		),
	);
	const hex = Array.from(bytes.subarray(0, 16), (b) =>
		b.toString(16).padStart(2, "0"),
	).join("");
	const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
	const lookup = () =>
		getWorkInteraction(db, { orgId: request.orgId, interactionId: id });
	if (!(await lookup())) {
		const work = request.workItemId
			? await getWorkItemById(db, request.workItemId, request.orgId)
			: null;
		const projectId = request.projectId ?? work?.projectId;
		const decisionDeck = DecisionEnvelopeSchema.parse({
			version: 1,
			kind: "question",
			classId: "decision-facts-changed",
			proposal: `Review updated facts for: ${request.subject}`.slice(0, 500),
			whyNow: change.slice(0, 2000),
			recommendation:
				"Ask the original owner for a revised proposal based on current facts.",
			reversibility: "two_way",
			tasteOrStrategy: true,
			protectedEffects: [],
			blastRadius:
				"Review only; the previous action cannot run from this card.",
			confidence: null,
			costOfWaiting: "The earlier decision remains blocked.",
			reasoning: `The previous card ${request.id} was based on outdated facts. ${change}`,
			options: [
				{
					id: "review",
					label: "Acknowledge change",
					intent: "approve",
					consequence:
						"Records that you reviewed the change. A revised proposal needs a separate decision.",
					cost: "No action is approved.",
				},
				{
					id: "dismiss",
					label: "Not needed",
					intent: "reject",
					consequence: "Close this review.",
					cost: "The earlier action stays blocked.",
				},
			],
		});
		await createWorkInteraction(db, {
			id,
			orgId: request.orgId,
			projectId,
			caseId: request.caseId,
			workItemId: projectId || request.caseId ? undefined : request.workItemId,
			kind: "question",
			subject: "Review changed decision facts",
			prompt:
				"The earlier decision is outdated. Review the change shown below before requesting a revised proposal.",
			creator: { type: "system", id: "tedix" },
			targetType: "user",
			targetId: request.targetId,
			metadata: { decisionDeck, replacesDecisionId: request.id },
			now,
		});
	}
	await retireDecisionReviews(db, {
		orgId: request.orgId,
		originalId: request.id,
		now,
	});
	return {
		change,
		requestId: id,
		reviewableThrough: detail.reviewableThrough,
		note: detail.note,
	};
}

/**
 * The refusal a person sees for a stale card. A newer Work comment is
 * recoverable: the client shows the note and answers again with
 * `reviewedChangesThrough`, binding the answer to that version.
 */
export function staleDecisionError(changed: {
	change: string;
	requestId?: string;
	reviewableThrough?: string;
	note?: string;
}) {
	return new ORPCError("CONFLICT", {
		message: changed.reviewableThrough
			? "There is a newer note on the linked task since this was asked. Read it, then save your answer again against the latest version."
			: changed.requestId
				? `${changed.change} Review the fresh card ${changed.requestId}.`
				: changed.change,
		data: {
			reason: changed.reviewableThrough ? "newer_comment" : "facts_changed",
			...(changed.requestId ? { freshRequestId: changed.requestId } : {}),
			...(changed.reviewableThrough
				? {
						reviewedChangesThrough: changed.reviewableThrough,
						note: changed.note,
					}
				: {}),
		},
	});
}
