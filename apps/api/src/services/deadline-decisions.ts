import {
	DEFAULT_DECK_ROUTING,
	DecisionEnvelopeSchema,
} from "@tedix/api-contract/schemas/os-decision-deck";
import type { DbQueryClient } from "@tedix/db/query-client";
import { listWorkItemsPage } from "@tedix/db/queries/work-items/crud";
import {
	createWorkInteraction,
	getWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";
import { getDeadlineDecision } from "@tedix/db/queries/work-items/interaction-reviews";

/** One owner-addressed decision per Work deadline, including resolved decisions. */
export async function materializeDeadlineDecisions(
	db: DbQueryClient,
	owner: { orgId: string; userId: string; projectId?: string },
	now = new Date(),
) {
	let created = 0;
	let scanned = 0;
	let hasMore = false;
	for (let offset = 0; offset < 1000; offset += 100) {
		const page = await listWorkItemsPage(db, {
			orgId: owner.orgId,
			accountableOwnerId: owner.userId,
			projectId: owner.projectId,
			limit: 100,
			offset,
		});
		scanned += page.data.length;
		hasMore = offset + page.data.length < page.total;
		for (const work of page.data) {
			const deadline = work.deadline ?? work.dueDate;
			if (
				work.accountableOwnerType !== "user" ||
				!deadline ||
				!["proposed", "accepted"].includes(work.disposition)
			)
				continue;
			const dueAt = deadline.length === 10 ? `${deadline}T23:59:59Z` : deadline;
			if (
				!Number.isFinite(Date.parse(dueAt)) ||
				Math.abs(Date.parse(dueAt) - now.getTime()) >
					DEFAULT_DECK_ROUTING.deadlineWindowHours * 3600000
			)
				continue;
			const digest = await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(
					`deadline:${owner.orgId}:${owner.userId}:${work.id}:${deadline}`,
				),
			);
			const hex = Array.from(new Uint8Array(digest), (byte) =>
				byte.toString(16).padStart(2, "0"),
			).join("");
			const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
			const deadlineKey = `${work.id}:${deadline}`;
			if (
				(await getWorkInteraction(db, {
					orgId: owner.orgId,
					interactionId: id,
				})) ||
				(await getDeadlineDecision(db, {
					orgId: owner.orgId,
					userId: owner.userId,
					workItemId: work.id,
					deadlineKey,
				}))
			)
				continue;
			const supplied = DecisionEnvelopeSchema.safeParse(
				work.metadata?.deadlineDecision,
			);
			const title = `Review ${work.title.slice(0, 70).replace(/[?.]+$/, "")}?`;
			const decision = supplied.success
				? { ...supplied.data, classId: "deadline.owner" }
				: DecisionEnvelopeSchema.parse({
						version: 1,
						kind: "decision",
						classId: "deadline.owner",
						proposal: title,
						whyNow: `You own this task, due ${deadline}.`,
						recommendation: `Your response is needed before ${deadline}.`,
						preview: {
							body: "Saves your response on this task. You carry out any outside action yourself.",
						},
						reversibility: "two_way",
						protectedEffects: [],
						blastRadius: "Your task",
						confidence: null,
						costOfWaiting: `The deadline is ${deadline}.`,
						reasoning: work.description ?? work.title,
						options: [
							{
								id: "reviewed",
								label: "Reviewed",
								intent: "approve",
								consequence: "Records your review; no outside action is taken.",
								cost: "None",
							},
							{
								id: "later",
								label: "Later",
								intent: "later",
								consequence: "Keeps the review open.",
								cost: "Less time before the deadline",
							},
						],
					});
			try {
				await createWorkInteraction(db, {
					id,
					orgId: owner.orgId,
					workItemId: work.id,
					kind: "question",
					subject: decision.proposal,
					prompt: `${decision.reasoning}\n\nOpen task: /work/items/${work.id}`,
					creator: { type: "system", id: "tedix" },
					targetType: "user",
					targetId: owner.userId,
					dueAt,
					metadata: {
						source: "deadline-decisions",
						deadlineKey,
						reason: decision.whyNow,
						decisionDeck: decision,
					},
					now: now.toISOString(),
				});
				created++;
			} catch (error) {
				if (
					!(await getWorkInteraction(db, {
						orgId: owner.orgId,
						interactionId: id,
					}))
				)
					throw error;
			}
		}
		if (!hasMore) break;
	}
	return { created, scanned, hasMore };
}
