import { call } from "@orpc/server";
import type { DeckNotUsefulReason } from "@tedix/api-contract/schemas/deck-pipeline";
import { addWorkItemCommentIfAbsent } from "@tedix/db/queries/work-items/comments";
import {
	getWorkItemById,
	getWorkItemBySourceIntentId,
} from "@tedix/db/queries/work-items/crud";
import type { getWorkInteraction } from "@tedix/db/queries/work-items/interactions";
import { safeExceptionTopology } from "../lib/safe-log-metadata";
import type { BaseContext } from "../rpc/orpc";

type Card = NonNullable<Awaited<ReturnType<typeof getWorkInteraction>>>;

export type BoardAnswer =
	| {
			kind: "answer";
			responseId: string;
			responseKind: string;
			body: string;
			choice?: string;
			/** The person's own words typed with the answer. */
			instruction?: string;
			at: string;
	  }
	| {
			kind: "not_useful";
			reason: DeckNotUsefulReason;
			note?: string;
			at: string;
	  };

const NOT_USEFUL_TEXT: Record<DeckNotUsefulReason, string> = {
	already_decided: "already decided",
	expired: "no longer current",
	agent_could_do: "an agent can do this",
	duplicate: "a duplicate",
	not_for_me: "not for me",
};

/** What the board should do with Work the answer creates. */
export function answerDisposition(answer: BoardAnswer) {
	if (answer.kind === "not_useful") return "cancel" as const;
	if (answer.choice === "approve" || answer.responseKind === "handoff_accepted")
		return "accept" as const;
	if (answer.choice === "reject" || answer.responseKind === "handoff_declined")
		return "cancel" as const;
	return "propose" as const;
}

export function answerSentence(subject: string, answer: BoardAnswer) {
	const said =
		answer.kind === "not_useful"
			? `marked it not needed (${NOT_USEFUL_TEXT[answer.reason]})${answer.note ? `: ${answer.note}` : ""}. Agents should not ask this again`
			: `answered: ${answer.body}`;
	const next =
		answer.kind === "answer" && answer.instruction
			? `\n\nWhat to do next, in their words: ${answer.instruction}`
			: "";
	return `Decision recorded for “${subject}” — ${said}.${next}`.slice(0, 4000);
}

/**
 * The person's answer takes effect on the board when they give it, without the
 * asking agent being alive: it is recorded on the card's Work, or on a Work
 * created once per card in the card's project. Fail-soft: the answer is
 * already durable and must not report failure here.
 */
export async function recordDecisionAnswerOnBoard(
	context: BaseContext,
	p: { orgId: string; request: Card; answer: BoardAnswer },
): Promise<{ workItemId: string; created: boolean } | null> {
	const { orgId, request, answer } = p;
	const personId = request.targetId;
	if (
		request.targetType !== "user" ||
		!personId ||
		request.kind === "coordination"
	)
		return null;
	try {
		let workItemId = request.workItemId;
		let created = false;
		const sentence = answerSentence(request.subject, answer);
		if (!workItemId) {
			// A Work proposal card materialises its own Work when accepted.
			if (!request.projectId || request.metadata.proposal !== undefined)
				return null;
			const sourceIntentId = `decision-card:${request.id}`;
			const lookup = () =>
				getWorkItemBySourceIntentId(context.db, { orgId, sourceIntentId });
			let work = await lookup();
			if (!work) {
				const { createProcedure } =
					await import("../rpc/routers/work-items/creation-reads");
				try {
					work = await call(
						createProcedure,
						{
							title: request.subject.slice(0, 500),
							description:
								`${request.prompt.slice(0, 8000)}\n\n${sentence}`.slice(
									0,
									10_000,
								),
							workKind: "other",
							riskLevel: "low",
							projectId: request.projectId,
							sourceIntentId,
							metadata: {
								source: "decision-card",
								requestId: request.id,
								...(answer.kind === "answer"
									? { responseId: answer.responseId }
									: {}),
							},
						},
						{ context },
					);
					created = true;
				} catch (error) {
					work = await lookup();
					if (!work) throw error;
				}
			}
			workItemId = work.id;
			if (created) await settleWork(context, work.id, request, answer);
		}
		const work = await getWorkItemById(context.db, workItemId, orgId);
		if (!work) return null;
		await addWorkItemCommentIfAbsent(context.db, {
			id: `decision-answer:${request.id}:${answer.kind === "answer" ? answer.responseId : "not-useful"}`,
			orgId,
			workItemId,
			authorType: "user",
			authorId: personId,
			recordActivity: true,
			body: sentence,
			metadata: {
				schema: "tedix.decision-answer.v1",
				requestId: request.id,
				decision: answer.kind === "answer" ? "answered" : "not_useful",
				...(answer.kind === "answer"
					? {
							responseId: answer.responseId,
							...(answer.choice ? { choice: answer.choice } : {}),
						}
					: { reason: answer.reason }),
			},
			createdAt: answer.at,
		});
		// A yes on a card whose Work is still only proposed makes that Work
		// actionable, carrying the person's words as the outcome.
		if (
			!created &&
			work.disposition === "proposed" &&
			request.kind !== "handoff" &&
			// Only an explicit approve option, never any typed answer.
			request.metadata.decisionDeck !== undefined &&
			answerDisposition(answer) === "accept"
		)
			await settleWork(context, workItemId, request, answer);
		return { workItemId, created };
	} catch (error) {
		console.warn("[decision-answer-board] answer not recorded on the board", {
			interactionId: request.id,
			exception: safeExceptionTopology(error),
		});
		return null;
	}
}

async function settleWork(
	context: BaseContext,
	workItemId: string,
	request: Card,
	answer: BoardAnswer,
) {
	const disposition = answerDisposition(answer);
	if (disposition === "propose") return;
	const { workItemsContractRouter } = await import("../rpc/routers/work-items");
	if (disposition === "accept")
		await call(
			workItemsContractRouter.accept,
			{
				id: workItemId,
				acceptanceContract: {
					version: 1,
					doneLooksLike: (answer.kind === "answer" && answer.instruction
						? `Do what the person asked on “${request.subject}”: ${answer.instruction}`
						: `Follow through on “${request.subject}” as decided, or post a short recommendation with evidence here.`
					).slice(0, 2000),
				},
			},
			{ context },
		);
	else
		await call(
			workItemsContractRouter.cancel,
			{
				id: workItemId,
				reason: answerSentence(request.subject, answer).slice(0, 2000),
			},
			{ context },
		);
}
