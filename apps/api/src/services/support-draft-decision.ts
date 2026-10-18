import type { SupportTicketRow } from "@tedix/db/schema/support";
import type { SupportConfiguration } from "@tedix/api-contract/schemas/support";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	ATTENTION_COPY,
	attentionCopy,
} from "@tedix/api-contract/utils/attention-copy";
import { supportObjectId } from "@tedix/api-contract/utils/support-report";
import {
	createWorkInteraction,
	getWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";
import { toJsonRecord } from "@tedix/db/utils/json";
import type { BaseContext } from "../rpc/orpc";
import { generateDecisionCard } from "./decision-card-generator";

export async function ensureSupportDraftDecision(
	context: BaseContext,
	row: SupportTicketRow,
	config: SupportConfiguration,
) {
	if (!row.draft || row.mirrorDelivery !== "delivered") return;
	const id = await supportObjectId(
		`support-draft-decision:${row.id}:${row.version}`,
	);
	if (
		await getWorkInteraction(context.db, {
			orgId: config.platformOrgId,
			interactionId: id,
		})
	)
		return;
	const decision = DecisionEnvelopeSchema.parse({
		version: 1,
		kind: "outbound",
		classId: "support.reply",
		proposal: attentionCopy("supportDraftProposal", {
			title: row.report.title,
		}).slice(0, 300),
		whyNow: ATTENTION_COPY.supportDraftWhyNow,
		recommendation: ATTENTION_COPY.supportDraftRecommendation,
		preview: { body: row.draft.body },
		reversibility: "one_way",
		tasteOrStrategy: true,
		protectedEffects: ["message"],
		blastRadius: ATTENTION_COPY.supportDraftBlastRadius,
		confidence: null,
		costOfWaiting: ATTENTION_COPY.supportDraftWaitingCost,
		reasoning:
			`${row.draft.evidence.join("\n")}\n\n${row.draft.nextStep}`.slice(
				0,
				8000,
			),
		lessons: [],
		options: [
			{
				id: "publish",
				label: ATTENTION_COPY.supportDraftApprove,
				intent: "approve",
				consequence: ATTENTION_COPY.supportDraftConsequence,
				cost: ATTENTION_COPY.noCost,
				effect: {
					kind: "publish_support",
					ticketId: row.id,
					expectedVersion: row.version,
				},
			},
			{
				id: "keep_private",
				label: ATTENTION_COPY.supportDraftReject,
				intent: "reject",
				consequence: ATTENTION_COPY.supportDraftRejectConsequence,
				cost: ATTENTION_COPY.supportDraftRejectCost,
			},
		],
	});
	const presentation = await generateDecisionCard(context, {
		orgId: config.platformOrgId,
		targetId: config.adminUserId,
		subject: decision.proposal,
		prompt: row.draft.body,
		kind: "question",
		metadata: { decisionDeck: decision },
	}).catch(() => null);
	try {
		await createWorkInteraction(context.db, {
			id,
			orgId: config.platformOrgId,
			workItemId: row.mirrorWorkItemId,
			kind: "question",
			subject: decision.proposal,
			prompt: row.draft.body,
			creator: context.tediId
				? { type: "tedi", id: context.tediId }
				: { type: "user", id: config.adminUserId },
			targetType: "user",
			targetId: config.adminUserId,
			metadata: toJsonRecord({
				source: "support-draft",
				reason: ATTENTION_COPY.supportDraftReason,
				decisionDeck: decision,
				...(presentation ? { cardPresentation: presentation } : {}),
				supportTicketId: row.id,
				supportVersion: row.version,
			}),
			now: new Date().toISOString(),
		});
	} catch (error) {
		if (
			!(await getWorkInteraction(context.db, {
				orgId: config.platformOrgId,
				interactionId: id,
			}))
		)
			throw error;
	}
}
