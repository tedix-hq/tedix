import {
	CARD_REVISION_STALL_MINUTES,
	CardFeedbackAnchorSchema,
	CardFeedbackFieldSchema,
	type KeptCardHunk,
	type CardAnchorResolution,
} from "@tedix/api-contract/schemas/card-revisions";
import { DeckCurationStateSchema } from "@tedix/api-contract/schemas/deck-curation";
import { getDecisionLearningConfig } from "@tedix/db/queries/decision-learning";
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
	const curator =
		actor.type === "tedi" &&
		request?.targetType === "user" &&
		(await getDecisionLearningConfig(context.db, orgId)).deckCurators.some(
			(g) =>
				g.enabled &&
				g.tediId === actor.id &&
				g.recipientId === request.targetId,
		);
	if (!request || (!recipient && !owner && !curator))
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only this card's recipient and owning agent can read its revisions",
		);
	return { orgId, actor, request, recipient, owner, ownerTediId, curator };
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
	const { readCardStyleRules } = await import("./card-style-rules");
	const open =
		change && !paired
			? {
					responseId: change.id,
					instruction:
						typeof change.metadata.instruction === "string"
							? change.metadata.instruction
							: change.body,
					requestedAt: change.respondedAt,
				}
			: null;
	// An owner that never applies the request must not lock the card for good.
	const stalled =
		open &&
		Date.now() - Date.parse(open.requestedAt) >
			CARD_REVISION_STALL_MINUTES * 60_000;
	return {
		revisions,
		styleRules: await readCardStyleRules(context, access),
		nextBeforeRevision:
			revisions[0] && revisions[0].revision > 1 ? revisions[0].revision : null,
		pending: stalled ? null : open,
		stalled: stalled ? open : null,
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
		(request.status !== "open" &&
			!(
				recipient &&
				input.restoreRevision &&
				request.status === "cancelled" &&
				DeckCurationStateSchema.safeParse(request.metadata.curation).success
			))
	)
		throw createError(ErrorCodes.CONFLICT, "The card changed; reload it");
	const history = await ensureCardInitialRevision(context, access);
	const latest = history.at(-1)!;
	if (
		request.status === "cancelled" &&
		latest.instruction !== JSON.stringify(request.metadata.curation)
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Only an immutable curator supersession can be restored",
		);
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
	let curation;
	const handled = DeckCurationStateSchema.safeParse(request.metadata.curation);
	if (restored && recipient && handled.success && handled.data.internalTask) {
		const task = await getWorkItemById(
			context.db,
			handled.data.internalTask.taskId,
			orgId,
		);
		const source = DecisionEnvelopeSchema.safeParse(
			request.metadata.decisionDeck,
		);
		const effect = source.success
			? source.data.options.find((option) => option.intent === "approve")
					?.effect
			: undefined;
		if (
			!task ||
			effect?.kind !== "create_owner_task" ||
			task.sourceIntentId !== `decision-owner-task:${request.id}` ||
			task.parentWorkItemId !== effect.workItemId ||
			task.accountableOwnerType !== "user" ||
			task.accountableOwnerId !== request.targetId ||
			task.title !== effect.title ||
			task.description !== effect.description ||
			task.metadata?.source !== "decision-owner-task" ||
			task.metadata?.requestId !== request.id ||
			task.metadata?.sendingReservedForOwner !== true
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"The internal task receipt is unavailable",
			);
		if (task.disposition !== "cancelled") {
			const { call } = await import("@orpc/server");
			const { cancelFactoryWorkItemProcedure } =
				await import("../rpc/routers/work-items/factory-lifecycle");
			await call(
				cancelFactoryWorkItemProcedure,
				{
					id: task.id,
					reason: "Recipient undid the agent's internal task decision",
				},
				{ context },
			);
		}
	}
	if (
		restored &&
		DeckCurationStateSchema.safeParse(request.metadata.curation).success
	) {
		try {
			curation = DeckCurationStateSchema.parse(
				JSON.parse(restored.instruction ?? "null"),
			);
			curation.revision = latest.revision + 1;
		} catch {
			curation = DeckCurationStateSchema.parse({
				schema: "tedix.deck-curation.v1",
				status: "open",
				successorId: null,
				penalty: 0,
				reason: "Restored original card",
				evidenceRefs: [],
				model: null,
				exampleIds: [],
			});
		}
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
		...(curation
			? { curation, expectedStatus: request.status as "open" | "cancelled" }
			: {}),
		body,
		cause,
		proposal: proposal ?? null,
		actorType: actor.type,
		actorId: actor.id,
		actorSessionId: actor.sessionId,
		instruction: curation
			? JSON.stringify(curation)
			: typeof change?.metadata.instruction === "string"
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
	const { syncSupportDraftFromCard } = await import("./support-draft-decision");
	await syncSupportDraftFromCard(context, request, body, {
		key: `card-revision:${revision.id}`,
		actorType: actor.type,
		actorId: actor.id,
	});
	const { queueDeckCuration } = await import("./deck-curation-trigger");
	await queueDeckCuration(
		context,
		{ ...request, status: curation?.status ?? request.status },
		actor,
	);
	return revision;
}
