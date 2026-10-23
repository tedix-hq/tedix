import type { SupportTicketRow } from "@tedix/db/schema/support";
import type { SupportConfiguration } from "@tedix/api-contract/schemas/support";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	ATTENTION_COPY,
	attentionCopy,
} from "@tedix/api-contract/utils/attention-copy";
import {
	redactSupportText,
	supportObjectId,
} from "@tedix/api-contract/utils/support-report";
import { getStaffSupportTicket } from "@tedix/db/queries/support";
import { defaultDecisionExpiry } from "@tedix/api-contract/utils/decision-expiry";
import {
	createWorkInteraction,
	getWorkInteraction,
	setSupportReplyPublishVersion,
	supersedeSupportDraftInteractions,
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
	) {
		await supersedeSupportDraftInteractions(context.db, {
			orgId: config.platformOrgId,
			ticketId: row.id,
			targetId: config.adminUserId,
			now: new Date().toISOString(),
		});
		return;
	}
	const now = new Date().toISOString();
	const expiresAt = defaultDecisionExpiry({
		now,
		kind: "outbound",
		classId: "support.reply",
	});
	const decision = DecisionEnvelopeSchema.parse({
		version: 1,
		kind: "outbound",
		classId: "support.reply",
		expiresAt,
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
			expiresAt,
			metadata: toJsonRecord({
				source: "support-draft",
				reason: ATTENTION_COPY.supportDraftReason,
				decisionDeck: decision,
				...(presentation ? { cardPresentation: presentation } : {}),
				supportTicketId: row.id,
				supportVersion: row.version,
			}),
			now,
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
	await supersedeSupportDraftInteractions(context.db, {
		orgId: config.platformOrgId,
		ticketId: row.id,
		targetId: config.adminUserId,
		now: new Date().toISOString(),
	});
}

/**
 * A new version of a support reply card becomes the ticket's draft, so Publish
 * sends what the card shows. Skipped when the ticket moved on since the card
 * was made; the card's publish then fails as stale instead of sending old text.
 */
export async function syncSupportDraftFromCard(
	context: BaseContext,
	request: { id: string; orgId: string; metadata: Record<string, unknown> },
	body: string,
	change: {
		key: string;
		actorType: "user" | "tedi" | "external_agent" | "system";
		actorId: string;
	},
) {
	const decision = DecisionEnvelopeSchema.safeParse(
		request.metadata.decisionDeck,
	);
	if (!decision.success) return;
	const optionIndex = decision.data.options.findIndex(
		(option) => option.effect?.kind === "publish_support",
	);
	const effect = decision.data.options[optionIndex]?.effect;
	if (effect?.kind !== "publish_support") return;
	const row = await getStaffSupportTicket(
		context.db,
		request.orgId,
		effect.ticketId,
	);
	const text = redactSupportText(body);
	if (
		!row?.draft ||
		row.version !== effect.expectedVersion ||
		row.draft.body === text
	)
		return;
	const { changeSupportTicket } = await import("./support");
	const draft = { ...row.draft, body: text };
	const changed = await changeSupportTicket(context, row, {
		key: change.key,
		actorId: change.actorId,
		actorType: change.actorType,
		now: new Date().toISOString(),
		patch: { draft },
		commentBody: `DRAFT — not sent\n${JSON.stringify(draft)}`,
	});
	await setSupportReplyPublishVersion(context.db, {
		orgId: request.orgId,
		interactionId: request.id,
		optionIndex,
		ticketVersion: changed.version,
		body: text,
	});
}
