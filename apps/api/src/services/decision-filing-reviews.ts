import * as z from "zod";
import type { DbQueryClient } from "@tedix/db/query-client";
import type { AgentSessionRequestOwner } from "@tedix/db/queries/agent-session-requests";
import { listRequestFilings } from "@tedix/db/queries/request-filings";
import { getUserConfig } from "@tedix/db/queries/user-configs";
import {
	createWorkInteraction,
	getWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";
import { attentionProjectBriefs } from "@tedix/db/queries/work-attention";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	ATTENTION_COPY,
	attentionCopy,
} from "@tedix/api-contract/utils/attention-copy";
import { toJsonRecord } from "@tedix/db/utils/json";

const ConfigSchema = z.strictObject({
	enabled: z.boolean().default(true),
	confidenceBelow: z.number().min(0).max(1).default(0.8),
	limit: z.number().int().min(1).max(20).default(10),
});

/** Each private filing event produces at most one review, addressed to its owner. */
export async function materializeFilingReviews(
	db: DbQueryClient,
	owner: AgentSessionRequestOwner,
) {
	const saved = await getUserConfig(db, {
		userId: owner.userId,
		namespace: `organization:${owner.organizationId}`,
		key: "decision-filing-reviews",
	});
	const config = ConfigSchema.parse(saved?.value ?? {});
	if (!config.enabled) return;
	const [history, projects] = await Promise.all([
		listRequestFilings(db, owner),
		attentionProjectBriefs(db, owner.organizationId),
	]);
	const seen = new Set<string | null>();
	const latest = history.filter((event) => {
		if (seen.has(event.targetId)) return false;
		seen.add(event.targetId);
		return true;
	});
	let created = 0;
	for (const event of latest) {
		const meta = event.metadata;
		if (
			meta?.by !== "auto" ||
			typeof meta.confidence !== "number" ||
			meta.confidence >= config.confidenceBelow ||
			typeof meta.projectId !== "string" ||
			!event.targetId
		)
			continue;
		const project = projects.find((project) => project.id === meta.projectId);
		if (
			!project ||
			(await getWorkInteraction(db, {
				orgId: owner.organizationId,
				interactionId: event.id,
			}))
		)
			continue;
		const decision = DecisionEnvelopeSchema.parse({
			version: 1,
			kind: "decision",
			classId: "filing.project",
			proposal: attentionCopy("filingProposal", { project: project.name }),
			whyNow: ATTENTION_COPY.filingWhyNow,
			recommendation: ATTENTION_COPY.filingRecommendation,
			reversibility: "two_way",
			tasteOrStrategy: true,
			protectedEffects: [],
			blastRadius: ATTENTION_COPY.filingBlastRadius,
			confidence: meta.confidence,
			costOfWaiting: ATTENTION_COPY.filingWaitingCost,
			reasoning: String(meta.reason ?? ATTENTION_COPY.filingFallbackReason),
			lessons: [],
			options: [
				{
					id: "keep",
					label: ATTENTION_COPY.filingKeep,
					intent: "approve",
					consequence: attentionCopy("filingKeepConsequence", {
						project: project.name,
					}),
					cost: ATTENTION_COPY.noCost,
				},
				{
					id: "correct",
					label: ATTENTION_COPY.filingCorrect,
					intent: "reject",
					consequence: ATTENTION_COPY.filingCorrectConsequence,
					cost: ATTENTION_COPY.filingCorrectionCost,
					effect: {
						kind: "file_request",
						requestId: event.targetId,
						projectId: null,
						expectedProjectId: project.id,
					},
				},
			],
		});
		try {
			await createWorkInteraction(db, {
				id: event.id,
				orgId: owner.organizationId,
				projectId: project.id,
				kind: "question",
				subject: decision.proposal,
				prompt: attentionCopy("filingReviewPrompt", {
					request: String(meta.text ?? "").slice(0, 16000),
					reason: decision.reasoning,
				}),
				creator: { type: "user", id: owner.userId },
				targetType: "user",
				targetId: owner.userId,
				metadata: toJsonRecord({
					source: "request-auto-filing",
					reason: ATTENTION_COPY.filingReviewReason,
					filingEventId: event.id,
					decisionDeck: decision,
				}),
				now: new Date().toISOString(),
			});
		} catch (error) {
			if (
				!(await getWorkInteraction(db, {
					orgId: owner.organizationId,
					interactionId: event.id,
				}))
			)
				throw error;
		}
		if (++created >= config.limit) break;
	}
}
