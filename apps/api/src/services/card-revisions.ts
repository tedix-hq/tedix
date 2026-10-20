import {
	CardFeedbackAnchorSchema,
	CardFeedbackFieldSchema,
	type KeptCardHunk,
	type CardAnchorResolution,
} from "@tedix/api-contract/schemas/card-revisions";
import { getWorkInteraction } from "@tedix/db/queries/work-items/interactions";
import {
	appendCardRevision,
	cardChangeHasRevision,
	getCardRevision,
	latestCardChangeRequest,
	listCardRevisions,
} from "@tedix/db/queries/work-items/card-revisions";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	WorkProposalMetadataSchema,
	type WorkProposal,
} from "@tedix/api-contract/schemas/work-interactions";
import { credentialCard } from "@tedix/api-contract/utils/card-secrets";
import { verifiedActiveWorkActor } from "../rpc/routers/work-items-principal";
import { requireOrgId } from "../rpc/org-scope";
import { createError, ErrorCodes, type BaseContext } from "../rpc/orpc";
import { getWorkItemById } from "@tedix/db/queries/work-items/crud";
import { getTediByIdForOrganization } from "@tedix/db/queries/tedis";

export async function cardOwningTedi(
	context: Pick<BaseContext, "db">,
	request: NonNullable<Awaited<ReturnType<typeof getWorkInteraction>>>,
) {
	const work = request.workItemId
		? await getWorkItemById(context.db, request.workItemId, request.orgId)
		: null;
	const id =
		work?.accountableOwnerType === "tedi" && work.accountableOwnerId
			? work.accountableOwnerId
			: request.creatorType === "tedi"
				? request.creatorId
				: null;
	const tedi = id
		? await getTediByIdForOrganization(context.db, id, request.orgId)
		: null;
	return tedi?.status === "active" && !tedi.retiredAt ? tedi.id : null;
}

export async function cardRevisionAccess(
	context: BaseContext,
	requestId: string,
) {
	const orgId = requireOrgId(context);
	const actor = await verifiedActiveWorkActor(context, orgId);
	const request = await getWorkInteraction(context.db, {
		orgId,
		interactionId: requestId,
	});
	const recipient =
		request?.targetType === "user" &&
		actor.type === "user" &&
		request.targetId === actor.id;
	const ownerTediId = request ? await cardOwningTedi(context, request) : null;
	const owner =
		actor.type === "tedi"
			? ownerTediId === actor.id
			: request?.creatorType === actor.type &&
				request.creatorId === actor.id &&
				(actor.type !== "external_agent" ||
					request.creatorSessionId === actor.sessionId);
	if (!request || (!recipient && !owner))
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only this card's recipient and owning agent can read its revisions",
		);
	return { orgId, actor, request, recipient, owner, ownerTediId };
}

export function cardOriginalBody(
	request: Awaited<ReturnType<typeof cardRevisionAccess>>["request"],
) {
	const decision = DecisionEnvelopeSchema.safeParse(
		request.metadata.decisionDeck,
	);
	return typeof request.metadata.cardContent === "string"
		? request.metadata.cardContent
		: decision.success
			? (decision.data.preview?.body ?? request.prompt)
			: request.prompt;
}

export async function readCardHistory(
	context: BaseContext,
	{
		orgId,
		requestId,
		beforeRevision,
	}: { orgId: string; requestId: string; beforeRevision?: number },
) {
	const access = await cardRevisionAccess(context, requestId);
	if (access.orgId !== orgId)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Card organization does not match the current organization",
		);
	const [revisions, change] = await Promise.all([
		listCardRevisions(context.db, orgId, requestId, beforeRevision),
		latestCardChangeRequest(context.db, orgId, requestId),
	]);
	const paired =
		change &&
		(await cardChangeHasRevision(context.db, orgId, requestId, change.id));
	return {
		revisions,
		nextBeforeRevision:
			revisions[0] && revisions[0].revision > 1 ? revisions[0].revision : null,
		pending:
			change && !paired
				? {
						responseId: change.id,
						instruction:
							typeof change.metadata.instruction === "string"
								? change.metadata.instruction
								: change.body,
						requestedAt: change.respondedAt,
					}
				: null,
	};
}

export async function ensureCardInitialRevision(
	context: BaseContext,
	access: Awaited<ReturnType<typeof cardRevisionAccess>>,
) {
	const { orgId, request } = access;
	const history = await listCardRevisions(context.db, orgId, request.id);
	if (history.length) return history;
	const saved = await appendCardRevision(context.db, {
		orgId,
		requestId: request.id,
		expectedVersion: request.version,
		expectedRevision: 0,
		body: cardOriginalBody(request),
		proposal:
			WorkProposalMetadataSchema.safeParse(request.metadata).data?.proposal ??
			null,
		cause: "initial",
		actorType: request.creatorType,
		actorId: request.creatorId,
		actorSessionId: request.creatorSessionId ?? undefined,
	});
	if (!saved)
		throw createError(
			ErrorCodes.CONFLICT,
			"The card changed; reload it before asking for changes",
		);
	return [saved];
}

export async function reviseCardContent(
	context: BaseContext,
	input: {
		requestId: string;
		expectedRequestVersion: number;
		expectedRevision: number;
		body?: string;
		proposal?: WorkProposal;
		responseId?: string;
		restoreRevision?: number;
		summary?: string;
		keptHunks?: KeptCardHunk[];
		anchorsResolved?: CardAnchorResolution[];
	},
) {
	const access = await cardRevisionAccess(context, input.requestId);
	const { orgId, request, actor, recipient, owner } = access;
	if (credentialCard(`${request.subject} ${request.prompt}`, request.metadata))
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Use connection settings to update credentials",
		);
	if (
		request.version !== input.expectedRequestVersion ||
		request.status !== "open"
	)
		throw createError(ErrorCodes.CONFLICT, "The card changed; reload it");
	const history = await ensureCardInitialRevision(context, access);
	const latest = history.at(-1)!;
	if (
		latest.revision !== input.expectedRevision &&
		!(input.expectedRevision === 0 && latest.revision === 1)
	)
		throw createError(
			ErrorCodes.CONFLICT,
			"A newer revision is available; reload the card",
		);
	const change = await latestCardChangeRequest(context.db, orgId, request.id);
	if (!recipient && input.keptHunks?.length)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only the recipient can keep original wording",
		);
	const anchors = CardFeedbackAnchorSchema.array().safeParse(
		change?.metadata.anchors,
	).data;
	if (
		input.anchorsResolved?.some(
			(resolution) => resolution.index >= (anchors?.length ?? 0),
		)
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Comment resolution refers to an unavailable comment",
		);
	if (
		!recipient &&
		(!owner ||
			!change ||
			change.id !== input.responseId ||
			history.some((r) => r.responseId === change.id))
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"The owning agent must cite the current change request responseId",
		);
	if (!recipient && input.restoreRevision)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only the recipient can restore a version",
		);
	const restored = input.restoreRevision
		? await getCardRevision(
				context.db,
				orgId,
				request.id,
				input.restoreRevision,
			)
		: undefined;
	const body = restored?.body ?? input.body;
	if (!body)
		throw createError(ErrorCodes.BAD_REQUEST, "That version is unavailable");
	const plan = WorkProposalMetadataSchema.safeParse(request.metadata);
	const proposal = restored?.proposal ?? input.proposal;
	if (plan.success && (!proposal || proposal.key !== plan.data.proposal.key))
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Include the revised structured proposal with the same plan key so approval creates exactly the new plan",
		);
	if (proposal && !plan.success)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"This card is not a structured plan",
		);
	if (request.metadata.schema === "tedix.outbound.v1") {
		if (!recipient || !request.workItemId)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Use the outbound review flow as the configured reviewer",
			);
		const { call } = await import("@orpc/server");
		const { outboundRouter } = await import("../rpc/routers/work-outbound");
		const current = await call(
			outboundRouter.get,
			{ workItemId: request.workItemId },
			{ context },
		);
		await call(
			outboundRouter.act,
			{
				workItemId: request.workItemId,
				expectedVersion: current.version,
				action: "edit",
				body,
				restoreRevision: input.restoreRevision,
				summary: input.summary,
				keptHunks: input.keptHunks,
			},
			{ context },
		);
		return (await listCardRevisions(context.db, orgId, request.id)).at(-1)!;
	}
	const cause = restored
		? "restore"
		: recipient
			? "human_edit"
			: "agent_rewrite";
	const revision = await appendCardRevision(context.db, {
		orgId,
		requestId: request.id,
		expectedVersion: request.version,
		expectedRevision: latest.revision,
		body,
		cause,
		proposal: proposal ?? null,
		actorType: actor.type,
		actorId: actor.id,
		actorSessionId: actor.sessionId,
		instruction:
			typeof change?.metadata.instruction === "string"
				? change.metadata.instruction
				: undefined,
		responseId: change?.id,
		field:
			CardFeedbackFieldSchema.safeParse(change?.metadata.field).data ?? "draft",
		anchors,
		anchorsResolved: input.anchorsResolved,
		summary: input.summary,
		keptHunks: input.keptHunks,
		parentRevision: restored?.revision ?? latest.revision,
	});
	if (!revision)
		throw createError(
			ErrorCodes.CONFLICT,
			"The card changed during the rewrite; reload it",
		);
	return revision;
}
