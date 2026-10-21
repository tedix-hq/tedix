import type * as z from "zod";
import {
	DeckCurationStateSchema,
	type CurateDeckCardInputSchema,
	type DeckCurationScopeSchema,
} from "@tedix/api-contract/schemas/deck-curation";
import {
	DeckCuratorRankerConfigSchema,
	type DeckRankSignal,
} from "@tedix/api-contract/schemas/deck-curator";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import {
	WorkInteractionInboxRowSchema,
	WorkProposalMetadataSchema,
} from "@tedix/api-contract/schemas/work-interactions";
import { credentialCard } from "@tedix/api-contract/utils/card-secrets";
import { humanReservedActionClasses } from "@tedix/api-contract/utils/approval-policy";
import {
	retrieveDeckExamples,
	deckRankSignal,
	currentDeckCuration,
} from "@tedix/api-contract/utils/deck-curator";
import {
	getWorkInteraction,
	listWorkInteractionInbox,
} from "@tedix/db/queries/work-items/interactions";
import {
	appendCardRevision,
	listCardRevisions,
} from "@tedix/db/queries/work-items/card-revisions";
import { reserveDeckRankingBudget } from "@tedix/db/queries/deck-curator-budget";
import { createError, ErrorCodes, type BaseContext } from "../rpc/orpc";
import { requestOutput } from "../rpc/routers/work-interactions";
import {
	deckCurationAccess,
	deckCurationEditAccess,
} from "./deck-curation-access";
import type { DecisionCardPresentation } from "@tedix/api-contract/schemas/decision-card-presentation";
import { checkDecisionCardCopy } from "@tedix/api-contract/utils/decision-card-copy";
import { listDecisionCardPresentations } from "@tedix/db/queries/work-items/card-presentation";
import { cardOriginalBody } from "./card-revisions";
import { runDecisionCardCopyModel } from "./decision-card-copy-model";

type Scope = z.infer<typeof DeckCurationScopeSchema>;
type Request = NonNullable<Awaited<ReturnType<typeof getWorkInteraction>>>;
/** Cards whose protected effect or policy keeps them with the human owner. */
export function criticalDeckRequest(request: Request) {
	const m = request.metadata;
	const d = DecisionEnvelopeSchema.safeParse(m.decisionDeck);
	return (
		request.kind === "handoff" ||
		m.schema === "tedix.outbound.v1" ||
		m.approvalOperation !== undefined ||
		Boolean(m.localImport) ||
		["high", "critical"].includes(String(m.riskLevel)) ||
		(m.protectedEffects !== undefined &&
			(!Array.isArray(m.protectedEffects) || m.protectedEffects.length > 0)) ||
		(m.decisionDeck !== undefined &&
			(!d.success || d.data.protectedEffects.length > 0)) ||
		humanReservedActionClasses(`${request.subject}\n${request.prompt}`).length >
			0
	);
}

export async function curationInbox(context: BaseContext, scope: Scope) {
	const { orgId } = await deckCurationAccess(context, scope);
	const observedAt = new Date().toISOString();
	const rows = await listWorkInteractionInbox(context.db, {
		orgId,
		targetType: "user",
		targetId: scope.recipientId,
		states: ["open"],
		limit: 200,
		observedAt,
		excludeSessionCapture: true,
	});
	return {
		items: rows.data.map((r) =>
			WorkInteractionInboxRowSchema.parse({
				request: requestOutput(r.request),
				effectiveState: r.effectiveState,
				canRespond: false,
				canCancel: false,
				workItem: r.workItem?.id
					? {
							id: r.workItem.id,
							title: r.workItem.title,
							projectId: r.workItem.projectId,
						}
					: null,
				responseCount: r.responseCount,
			}),
		),
		complete: !rows.hasMore,
		observedAt,
	};
}

async function append(
	context: BaseContext,
	scope: Scope,
	request: Request,
	expectedRevision: number,
	body: string,
	state: z.infer<typeof DeckCurationStateSchema>,
) {
	const { orgId, actor } = await deckCurationAccess(context, scope);
	return appendCuration(context, {
		orgId,
		actor,
		request,
		expectedRevision,
		body,
		state,
		skipRevisedSince: scope.skipRevisedSince,
	});
}

/** Appends one immutable revision carrying the curation state; cancelling never answers the card. */
export async function appendCuration(
	context: Pick<BaseContext, "db">,
	{
		orgId,
		actor,
		request,
		expectedRevision,
		body,
		state,
		skipRevisedSince,
		presentation,
	}: {
		orgId: string;
		actor: { type: string; id: string; sessionId?: string };
		request: Request;
		expectedRevision: number;
		body: string;
		state: z.infer<typeof DeckCurationStateSchema>;
		skipRevisedSince?: string;
		presentation?: DecisionCardPresentation;
	},
) {
	let history = await listCardRevisions(context.db, orgId, request.id);
	if (skipRevisedSince && history.some((r) => r.createdAt >= skipRevisedSince))
		throw createError(
			ErrorCodes.CONFLICT,
			"Card was recently revised; skip it",
		);
	if (!history.length) {
		const initial = await appendCardRevision(context.db, {
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
		});
		if (!initial)
			throw createError(
				ErrorCodes.CONFLICT,
				"The card changed before its initial revision",
			);
		history = [initial];
	}
	const latest = history.at(-1)!;
	if (
		latest.revision !== expectedRevision &&
		!(expectedRevision === 0 && latest.revision === 1)
	)
		throw createError(ErrorCodes.CONFLICT, "Reload the latest card revision");
	const curation = {
		...state,
		revision: latest.revision + 1,
		draftBody:
			currentDeckCuration(request.metadata)?.draftBody ??
			cardOriginalBody(request),
	};
	const previousFace = presentation
		? (
				await listDecisionCardPresentations(context.db, {
					orgId,
					personId: request.targetId,
					requests: [request],
				})
			)[0]?.presentation
		: undefined;
	const revision = await appendCardRevision(context.db, {
		orgId,
		requestId: request.id,
		expectedVersion: request.version,
		expectedRevision: latest.revision,
		body,
		proposal:
			WorkProposalMetadataSchema.safeParse(request.metadata).data?.proposal ??
			null,
		cause:
			presentation && actor.type === "user" ? "human_edit" : "agent_rewrite",
		actorType: actor.type,
		actorId: actor.id,
		actorSessionId: actor.sessionId,
		instruction: JSON.stringify(curation),
		curation: presentation && actor.type === "user" ? undefined : curation,
		presentation,
		summary: presentation
			? JSON.stringify({
					faceBefore: previousFace ?? request.metadata.cardPresentation ?? null,
					faceAfter: presentation,
				})
			: undefined,
	});
	if (!revision)
		throw createError(ErrorCodes.CONFLICT, "The card changed during curation");
	return revision;
}

export async function curateDeckCard(
	context: BaseContext,
	input: z.infer<typeof CurateDeckCardInputSchema>,
) {
	const { orgId, actor, recipient } = await deckCurationEditAccess(
		context,
		input,
	);
	const request = await getWorkInteraction(context.db, {
		orgId,
		interactionId: input.requestId,
	});
	if (
		!request ||
		request.targetType !== "user" ||
		request.targetId !== input.recipientId
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Card is outside the delegated recipient inbox",
		);
	if (
		request.version !== input.expectedRequestVersion ||
		request.status !== "open"
	)
		throw createError(ErrorCodes.CONFLICT, "Reload the open card");
	if (
		(!recipient &&
			credentialCard(
				`${request.subject} ${request.prompt}`,
				request.metadata,
			)) ||
		request.metadata.schema === "tedix.outbound.v1"
	)
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Use the original credential or outbound review flow",
		);
	if (
		input.presentation &&
		(input.presentation.version !== 2 ||
			!("context" in input.presentation) ||
			!input.presentation.context ||
			checkDecisionCardCopy(input.presentation).length ||
			input.presentation.sourceFingerprint)
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"Supply checked face text without a generator fingerprint",
		);
	if (
		input.presentation &&
		(input.successorId || input.handleInternally || input.body !== undefined)
	)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"A face correction cannot also rewrite the source, handle or supersede a card",
		);
	if (input.body && input.body.split(/\s+/u).length > 60)
		throw createError(
			ErrorCodes.BAD_REQUEST,
			"The curated story must contain at most 60 words",
		);
	if (input.handleInternally) {
		if (input.successorId || input.body)
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"Internal handling uses the stored action without rewriting it",
			);
		const { handleInternalDecision } =
			await import("./internal-decision-handling");
		return handleInternalDecision(context, request, input.expectedRevision);
	}
	if (input.successorId) {
		const successor = await getWorkInteraction(context.db, {
			orgId,
			interactionId: input.successorId,
		});
		if (criticalDeckRequest(request))
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Critical policy cards cannot be superseded by curation",
			);
		if (
			!successor ||
			successor.id === request.id ||
			successor.status !== "open" ||
			successor.targetType !== "user" ||
			successor.targetId !== input.recipientId ||
			(successor.expiresAt && successor.expiresAt <= new Date().toISOString())
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"Successor must be a different live card for the same recipient",
			);
	}
	const prior = DeckCurationStateSchema.safeParse(request.metadata.curation);
	const state = DeckCurationStateSchema.parse({
		schema: "tedix.deck-curation.v1",
		status: input.successorId ? "cancelled" : "open",
		successorId: input.successorId ?? null,
		penalty: prior.success ? prior.data.penalty : 0,
		reason: input.reason,
		evidenceRefs: input.evidenceRefs,
		model: prior.success ? prior.data.model : null,
		exampleIds: prior.success ? prior.data.exampleIds : [],
	});
	const body = input.body ?? cardOriginalBody(request);
	return appendCuration(context, {
		orgId,
		actor,
		request,
		expectedRevision: input.expectedRevision,
		body,
		state,
		skipRevisedSince: input.skipRevisedSince,
		presentation: input.presentation,
	});
}

export async function rankCurationInbox(context: BaseContext, scope: Scope) {
	const { orgId, grant, policy } = await deckCurationAccess(context, scope);
	const inbox = await curationInbox(context, scope);
	if (!inbox.complete)
		throw createError(ErrorCodes.CONFLICT, "Curation inbox is incomplete");
	const config = DeckCuratorRankerConfigSchema.parse(
		policy.deckCuratorRanker ?? {},
	);
	const signals: DeckRankSignal[] = [];
	let reservedMicros = 0;
	const deadline = Date.now() + config.runTimeoutMs;
	for (const item of inbox.items) {
		const request = await getWorkInteraction(context.db, {
			orgId,
			interactionId: item.request.id,
		});
		if (!request || request.status !== "open")
			throw createError(ErrorCodes.CONFLICT, "Ranking source changed");
		const examples = retrieveDeckExamples(
			{ title: request.subject, summary: cardOriginalBody(request) },
			grant.examples,
			inbox.items.map((r) => ({ id: r.request.id, title: r.request.subject })),
		);
		const retained = (reason: DeckRankSignal["reason"]) =>
			signals.push({
				cardId: request.id,
				label: null,
				penalty: 0,
				reason,
				exampleIds: [],
			});
		if (criticalDeckRequest(request)) {
			retained("critical");
			continue;
		}
		if (
			scope.skipRevisedSince &&
			(await listCardRevisions(context.db, orgId, request.id)).some(
				(r) => r.createdAt >= scope.skipRevisedSince!,
			)
		) {
			retained("recently_revised");
			continue;
		}
		if (!config.enabled) {
			retained("disabled");
			continue;
		}
		if (examples.length !== 8) {
			retained("insufficient_examples");
			continue;
		}
		if (Date.now() >= deadline) {
			retained("time_budget");
			continue;
		}
		if (
			reservedMicros + config.perCardReservationMicros >
				config.perRunReservationMicros ||
			!(await reserveDeckRankingBudget(context.db, {
				organizationId: orgId,
				amountMicros: config.perCardReservationMicros,
				dailyLimitMicros: config.dailyReservationMicros,
			}))
		) {
			retained("budget_exhausted");
			continue;
		}
		reservedMicros += config.perCardReservationMicros;
		const text = await runDecisionCardCopyModel(
			context,
			JSON.stringify({
				title: request.subject,
				summary: cardOriginalBody(request).slice(0, 2000),
				examples: examples.map(({ title, summary, label }) => ({
					title,
					summary,
					label,
				})),
			}),
			{
				orgId,
				source: "deck_curator_rank",
				model: config.model,
				maxTokens: 128,
				timeoutMs: Math.max(
					1,
					Math.min(config.timeoutMs, deadline - Date.now()),
				),
				system: config.instructions,
				rewriteInstruction: "Return the final JSON label only. /no_think",
			},
		);
		const signal = deckRankSignal(request.id, text, examples, config);
		signals.push(signal);
		if (signal.label) {
			const state = DeckCurationStateSchema.parse({
				schema: "tedix.deck-curation.v1",
				status: "open",
				successorId: null,
				penalty: signal.penalty,
				reason: signal.reason,
				evidenceRefs: examples.map((e) => e.evidenceRef),
				model: config.model,
				exampleIds: signal.exampleIds,
			});
			await append(
				context,
				scope,
				request,
				Number(request.metadata.cardRevision ?? 0),
				cardOriginalBody(request),
				state,
			);
		}
	}
	return { signals, reservedMicros };
}
