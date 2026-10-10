import { ListWorkInteractionCliInboxResultSchema } from "@tedix/api-contract/schemas/work-interactions";
import { implement } from "@orpc/server";
import {
	type AgentReplyDeliveryGateResult,
	AgentReplyDeliveryGateResultSchema,
} from "@tedix/api-contract/schemas/agent-turn-triage";
import { workInteractionsContract } from "@tedix/api-contract/contracts/work-interactions";
import {
	cancelWorkInteraction,
	createWorkInteraction,
	delegateWorkInteraction,
	getWorkInteraction,
	getWorkInteractionAttention,
	listWorkInteractionInbox,
	listWorkInteractionResponses,
	respondToWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";
import {
	listUndeliveredWorkInteractionResponses,
	listWorkInteractionDeliveries,
	recordWorkInteractionDeliveries,
} from "@tedix/db/queries/work-items/interaction-deliveries";
import { listTediDisplayNamesByIds } from "@tedix/db/queries/tedis";
import {
	getLatestReplyDraft,
	recordAutoReplyDelivery,
} from "@tedix/db/queries/work-items/reply-drafts";
import { publishMcpInteractionResponse } from "../../lib/mcp-subscriptions";
import { decisionCaptureLearningSignal } from "../../services/decision-learning-signal";
import {
	observedLearningActor,
	recordObservedLearningInteraction,
} from "../../services/learning-interaction-recorder";
import { startIncrementalLessons } from "../../services/lesson-incremental-dispatch";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
	withAuthorization,
} from "../orpc";
import { verifiedActiveWorkActor } from "./work-items-principal";
import {
	requireOwnerAdminWorkItemAuthor,
	rethrowWorkControlError,
} from "./work-items/policy-helpers";

const interactionsOs = implement(
	workInteractionsContract,
).$context<BaseContext>();
const authenticatedOs = interactionsOs.use(withAuth);
const readOs = authenticatedOs.use(AUTHZ.messagingRead);
const writeOs = authenticatedOs.use(
	withAuthorization(
		{
			handlerOwnedUserAuthorization:
				"Every mutation derives and revalidates the active user, tedi, or external-agent credential; DB queries enforce org/context/target scope",
		},
		"mcp:messaging.write",
	),
);

function rethrowInteractionError(error: unknown): never {
	return rethrowWorkControlError(error, { invalidPrincipal: "forbidden" });
}

type InteractionRow = NonNullable<
	Awaited<ReturnType<typeof getWorkInteraction>>
>;
/** The stored attention verdict, shown to clients as `metadata.attention`. */
type AttentionOverlay = { kind: string | null; need: string | null } | null;

/** The resolving answer of a session question and its delivery row. */
export interface ResolutionDelivery {
	responderType: string | null;
	source: string | null;
	sessionId: string | null;
	deliveredAt: string | null;
	deliveredVia: string | null;
	acknowledgedAt: string | null;
	handoffTo: string | null;
}

const DELIVERY_VIAS = new Set([
	"hook",
	"supervisor_resume",
	"codex_queue",
	"codex_resume",
	"prompt_context",
	"handoff",
]);

/**
 * Where a session question's answer stands (`metadata.delivery`), or null
 * when there is nothing to tell: not a session question, not the user's
 * answer, a reply typed in the asking session itself, or an answer recorded
 * before the delivery ledger existed.
 */
export function deliveryOverlay(
	questionSessionId: unknown,
	resolution: ResolutionDelivery | null,
) {
	if (typeof questionSessionId !== "string" || !resolution) return null;
	if (resolution.responderType !== "user") return null;
	if (
		resolution.source === "user-reply" &&
		resolution.sessionId === questionSessionId
	)
		return null;
	if (resolution.deliveredVia === "legacy") return null;
	const via =
		resolution.deliveredVia && DELIVERY_VIAS.has(resolution.deliveredVia)
			? resolution.deliveredVia
			: null;
	return {
		state: !resolution.deliveredAt
			? ("saved" as const)
			: via === "handoff"
				? ("handed_off" as const)
				: resolution.acknowledgedAt
					? ("acknowledged" as const)
					: ("delivered" as const),
		via,
		deliveredAt: resolution.deliveredAt,
		acknowledgedAt: resolution.acknowledgedAt,
		handoffTo: resolution.handoffTo,
	};
}

function requestOutput(
	row: InteractionRow,
	attention?: AttentionOverlay,
	resolution?: ResolutionDelivery | null,
) {
	if (!row.targetType || !row.targetId) {
		throw createError(
			ErrorCodes.INTERNAL_SERVER_ERROR,
			"Stored Work interaction is missing its required target principal",
		);
	}
	return {
		id: row.id,
		orgId: row.orgId,
		workItemId: row.workItemId,
		caseId: row.caseId,
		projectId: row.projectId,
		kind: row.kind,
		subject: row.subject,
		prompt: row.prompt,
		requestedFromType: row.targetType,
		requestedFromId: row.targetId,
		creatorType: row.creatorType as "user" | "tedi" | "external_agent",
		creatorId: row.creatorId,
		creatorSessionId: row.creatorSessionId,
		state: row.status,
		requestedAt: row.createdAt,
		dueAt: row.dueAt,
		expiresAt: row.expiresAt,
		resolvedAt: row.resolvedAt,
		version: row.version,
		metadata: withDelivery(
			attention?.kind
				? {
						...row.metadata,
						attention: { kind: attention.kind, need: attention.need },
						// The Office reads the one-line ask under this name.
						...(attention.kind === "needs_you" && attention.need
							? { neededFromYou: attention.need }
							: {}),
					}
				: row.metadata,
			resolution,
		),
	};
}

function withDelivery(
	metadata: InteractionRow["metadata"],
	resolution: ResolutionDelivery | null | undefined,
): InteractionRow["metadata"] {
	const delivery = deliveryOverlay(metadata.sessionId, resolution ?? null);
	return delivery ? { ...metadata, delivery } : metadata;
}

function rowAttention(row: {
	attentionKind: string | null;
	attentionNeed: string | null;
}): AttentionOverlay {
	return { kind: row.attentionKind, need: row.attentionNeed };
}

function rowResolution(row: {
	resolution: (ResolutionDelivery & { id: string | null }) | null;
}): ResolutionDelivery | null {
	return row.resolution?.id ? row.resolution : null;
}

type ResponseRow = Awaited<
	ReturnType<typeof listWorkInteractionResponses>
>[number];
function responseOutput(row: ResponseRow) {
	return {
		id: row.id,
		requestId: row.interactionId,
		responseKind: row.responseKind,
		body: row.body,
		artifactRef: row.artifactRef,
		artifactVersion: row.artifactVersion,
		artifactDigest: row.artifactDigest,
		resolvesRequest: row.resolvesRequest,
		respondedByType: row.responderType as "user" | "tedi" | "external_agent",
		respondedById: row.responderId,
		respondedBySessionId: row.responderSessionId,
		respondedAt: row.respondedAt,
		metadata: row.metadata,
	};
}

function effectiveState(row: InteractionRow, observedAt: string) {
	return row.status === "open" &&
		row.expiresAt !== null &&
		row.expiresAt <= observedAt
		? ("expired" as const)
		: row.status;
}

const createProcedure = writeOs.create.handler(async ({ input, context }) => {
	const orgId = requireOrgId(context);
	const actor = await verifiedActiveWorkActor(context, orgId);
	const requestedAt = new Date().toISOString();
	if (input.dueAt !== undefined && input.dueAt <= requestedAt) {
		throw createError(
			ErrorCodes.UNPROCESSABLE_CONTENT,
			"Work interaction due time must be in the future",
		);
	}
	if (input.expiresAt !== undefined && input.expiresAt <= requestedAt) {
		throw createError(
			ErrorCodes.UNPROCESSABLE_CONTENT,
			"Work interaction expiry must be in the future",
		);
	}
	if (input.dueAt && input.expiresAt && input.expiresAt < input.dueAt) {
		throw createError(
			ErrorCodes.UNPROCESSABLE_CONTENT,
			"Work interaction expiry cannot precede its due time",
		);
	}
	try {
		const created = await createWorkInteraction(context.db, {
			id: crypto.randomUUID(),
			orgId,
			workItemId: input.workItemId,
			caseId: input.caseId,
			projectId: input.projectId,
			kind: input.kind,
			subject: input.subject,
			prompt: input.prompt,
			creator: actor,
			targetType: input.requestedFrom.type,
			targetId: input.requestedFrom.id,
			dueAt: input.dueAt,
			expiresAt: input.expiresAt,
			metadata: input.metadata,
			now: requestedAt,
		});
		// A captured agent turn learns after the response whether it needs
		// its user (and what, in one line).
		if (
			context.waitUntil &&
			created.kind === "question" &&
			created.targetType === "user" &&
			input.metadata?.schema === "tedix.decision-capture.v1"
		)
			context.waitUntil(
				import("./agent-turn-triage")
					.then(({ annotateAgentTurnAttention }) =>
						annotateAgentTurnAttention(context, created),
					)
					.catch((error: unknown) =>
						console.warn("agent-turn attention failed", {
							requestId: created.id,
							error: error instanceof Error ? error.message : String(error),
						}),
					),
			);
		return requestOutput(created);
	} catch (error) {
		rethrowInteractionError(error);
	}
});

const respondProcedure = writeOs.respond.handler(async ({ input, context }) => {
	const orgId = requireOrgId(context);
	const actor = await verifiedActiveWorkActor(context, orgId);
	try {
		const response = await respondToWorkInteraction(context.db, {
			id: crypto.randomUUID(),
			orgId,
			interactionId: input.requestId,
			expectedVersion: input.expectedRequestVersion,
			responder: actor,
			responseKind: input.responseKind,
			body: input.body,
			artifactRef: input.artifactRef,
			artifactVersion: input.artifactVersion,
			artifactDigest: input.artifactDigest,
			resolvesRequest: input.resolvesRequest,
			metadata: input.metadata,
			now: new Date().toISOString(),
		});
		const request = await getWorkInteraction(context.db, {
			orgId,
			interactionId: input.requestId,
		});
		if (!request)
			throw createError(ErrorCodes.NOT_FOUND, "Work interaction not found");
		if (response.responseKind !== "coordination_update") {
			await publishMcpInteractionResponse(context.env, {
				organizationId: orgId,
				requestId: request.id,
				responseId: response.id,
				respondedAt: response.respondedAt,
			});
		}
		await recordDecisionLearning(context, orgId, request, response);
		return {
			request: requestOutput(request),
			response: responseOutput(response),
		};
	} catch (error) {
		rethrowInteractionError(error);
	}
});

/**
 * A decision-capture answer that has been stored feeds the learning ledger:
 * the user's decision, and their verdict on any tedi draft it cites.
 * Fail-soft: the answer is already durable and must not report failure here.
 */
async function recordDecisionLearning(
	context: BaseContext,
	orgId: string,
	request: InteractionRow,
	response: ResponseRow,
): Promise<void> {
	try {
		const draft =
			typeof response.metadata?.draftId === "string"
				? await getLatestReplyDraft(context.db, {
						orgId,
						interactionId: request.id,
					})
				: null;
		const signal = decisionCaptureLearningSignal({
			organizationId: orgId,
			request,
			response,
			draft,
		});
		if (!signal) return;
		await recordObservedLearningInteraction(context, signal);
		// The person's lessons learn the decision now, not at night.
		const actor = observedLearningActor(context);
		if (actor.actorType === "user" && actor.actorId)
			await startIncrementalLessons(context.env, orgId, actor.actorId);
	} catch (error) {
		console.warn("[learning-feed] decision-capture signal skipped", {
			interactionId: request.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
}

const delegateProcedure = writeOs.delegate.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const actor = await verifiedActiveWorkActor(context, orgId);
		try {
			return requestOutput(
				await delegateWorkInteraction(context.db, {
					orgId,
					interactionId: input.requestId,
					expectedVersion: input.expectedRequestVersion,
					actor,
					tediId: input.tediId,
					now: new Date().toISOString(),
				}),
			);
		} catch (error) {
			rethrowInteractionError(error);
		}
	},
);

const cancelProcedure = writeOs.cancel.handler(async ({ input, context }) => {
	const orgId = requireOrgId(context);
	const actor = await verifiedActiveWorkActor(context, orgId);
	try {
		return requestOutput(
			await cancelWorkInteraction(context.db, {
				orgId,
				interactionId: input.requestId,
				expectedVersion: input.expectedRequestVersion,
				actor,
				now: new Date().toISOString(),
			}),
		);
	} catch (error) {
		rethrowInteractionError(error);
	}
});

/** A draft's stored gate audit; an unreadable row reads as not reached. */
function storedGate(value: unknown): AgentReplyDeliveryGateResult | null {
	const parsed = AgentReplyDeliveryGateResultSchema.safeParse(value);
	return parsed.success ? parsed.data : null;
}

const getProcedure = readOs.get.handler(async ({ input, context }) => {
	const orgId = requireOrgId(context);
	try {
		const request = await getWorkInteraction(context.db, {
			orgId,
			interactionId: input.requestId,
		});
		if (!request)
			throw createError(ErrorCodes.NOT_FOUND, "Work interaction not found");
		const actor = await verifiedActiveWorkActor(context, orgId);
		const isTarget =
			request.targetType === actor.type && request.targetId === actor.id;
		const isCreator =
			request.creatorType === actor.type && request.creatorId === actor.id;
		if (!isTarget && !isCreator) {
			await requireOwnerAdminWorkItemAuthor(
				context,
				orgId,
				"Work interaction audit detail",
			);
		}
		const [rows, latestDraft, attention, deliveries] = await Promise.all([
			listWorkInteractionResponses(context.db, {
				orgId,
				interactionId: request.id,
				limit: input.responseLimit + 1,
				afterRespondedAt: input.responseCursor?.at,
				afterId: input.responseCursor?.id,
			}),
			getLatestReplyDraft(context.db, { orgId, interactionId: request.id }),
			getWorkInteractionAttention(context.db, {
				orgId,
				interactionId: request.id,
			}),
			request.status === "resolved"
				? listWorkInteractionDeliveries(context.db, {
						orgId,
						interactionId: request.id,
					})
				: Promise.resolve([]),
		]);
		const resolving = rows.find((row) => row.resolvesRequest);
		const delivery = resolving
			? deliveries.find((row) => row.responseId === resolving.id)
			: undefined;
		// A tedi's auto reply answered for the user; they may still correct it.
		const correctable =
			request.status === "resolved" &&
			request.kind === "question" &&
			request.targetType === "user" &&
			resolving?.responderType === "tedi" &&
			resolving.metadata.draftOutcome === "auto";
		const [drafter] = latestDraft
			? await listTediDisplayNamesByIds(context.db, {
					organizationId: orgId,
					ids: [latestDraft.drafterId],
				})
			: [];
		const hasMore = rows.length > input.responseLimit;
		const data = rows.slice(0, input.responseLimit);
		const last = data.at(-1);
		const observedAt = new Date().toISOString();
		const state = effectiveState(request, observedAt);
		return {
			request: requestOutput(
				request,
				attention,
				resolving
					? {
							responderType: resolving.responderType,
							source: stringOrNull(resolving.metadata.source),
							sessionId: stringOrNull(resolving.metadata.sessionId),
							deliveredAt: delivery?.deliveredAt ?? null,
							deliveredVia: delivery?.deliveredVia ?? null,
							acknowledgedAt: delivery?.acknowledgedAt ?? null,
							handoffTo: delivery?.handoffTo ?? null,
						}
					: null,
			),
			effectiveState: state,
			canRespond: isTarget && (state === "open" || correctable),
			canCancel: isCreator && state === "open",
			latestDraft: latestDraft
				? {
						id: latestDraft.id,
						body: latestDraft.body,
						rationale: latestDraft.rationale,
						drafterId: latestDraft.drafterId,
						drafterName: drafter ? drafter.displayName || drafter.name : null,
						createdAt: latestDraft.createdAt,
						turnType: latestDraft.turnType,
						delivery: latestDraft.delivery,
						gate: storedGate(latestDraft.gate),
					}
				: null,
			responses: {
				data: data.map(responseOutput),
				nextCursor:
					hasMore && last ? { at: last.respondedAt, id: last.id } : null,
				hasMore,
			},
		};
	} catch (error) {
		rethrowInteractionError(error);
	}
});

const listInboxProcedure = readOs.listInbox.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const caller = await verifiedActiveWorkActor(context, orgId);
		const observedAt = new Date().toISOString();
		const page = await listWorkInteractionInbox(context.db, {
			orgId,
			states: input.states,
			kinds: input.kinds,
			urgency: input.urgency,
			workItemId: input.workItemId,
			projectId: input.projectId,
			targetType: caller.type,
			targetId: caller.id,
			cursor: input.cursor,
			limit: input.limit,
			observedAt,
		});
		return {
			data: page.data.map((row) => ({
				request: requestOutput(
					row.request,
					rowAttention(row),
					rowResolution(row),
				),
				effectiveState: row.effectiveState,
				canRespond: row.effectiveState === "open",
				canCancel: false,
				workItem: row.workItem?.id ? row.workItem : null,
				responseCount: row.responseCount,
			})),
			nextCursor: page.nextCursor,
			hasMore: page.hasMore,
			observedAt,
		};
	},
);

const listCliInboxProjectionProcedure = readOs.listCliInboxProjection.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const caller = await verifiedActiveWorkActor(context, orgId);
		const observedAt = new Date().toISOString();
		const page = await listWorkInteractionInbox(context.db, {
			orgId,
			states: input.states,
			kinds: input.kinds,
			urgency: input.urgency,
			workItemId: input.workItemId,
			projectId: input.projectId,
			targetType: caller.type,
			targetId: caller.id,
			cursor: input.cursor,
			limit: input.limit,
			observedAt,
		});
		return ListWorkInteractionCliInboxResultSchema.parse({
			data: page.data.map((row) => {
				const { metadata: _metadata, ...request } = requestOutput(row.request);
				return {
					request: {
						...request,
						prompt: request.prompt.slice(0, 800),
						promptComplete: request.prompt.length <= 800,
					},
					effectiveState: row.effectiveState,
					canRespond: row.effectiveState === "open",
					canCancel: false,
					workItem: row.workItem?.id ? row.workItem : null,
					responseCount: row.responseCount,
				};
			}),
			nextCursor: page.nextCursor,
			hasMore: page.hasMore,
			observedAt,
		});
	},
);

const listOutboxProcedure = readOs.listOutbox.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const caller = await verifiedActiveWorkActor(context, orgId);
		const observedAt = new Date().toISOString();
		const page = await listWorkInteractionInbox(context.db, {
			orgId,
			states: input.states,
			kinds: input.kinds,
			urgency: input.urgency,
			workItemId: input.workItemId,
			projectId: input.projectId,
			creatorType: caller.type,
			creatorId: caller.id,
			cursor: input.cursor,
			limit: input.limit,
			observedAt,
		});
		return {
			data: page.data.map((row) => ({
				request: requestOutput(
					row.request,
					rowAttention(row),
					rowResolution(row),
				),
				effectiveState: row.effectiveState,
				canRespond: false,
				canCancel: row.effectiveState === "open",
				workItem: row.workItem?.id ? row.workItem : null,
				responseCount: row.responseCount,
			})),
			nextCursor: page.nextCursor,
			hasMore: page.hasMore,
			observedAt,
		};
	},
);

const listAuditProcedure = readOs.listAudit.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		await requireOwnerAdminWorkItemAuthor(
			context,
			orgId,
			"Work interaction audit",
		);
		const observedAt = new Date().toISOString();
		const page = await listWorkInteractionInbox(context.db, {
			orgId,
			states: input.states,
			kinds: input.kinds,
			urgency: input.urgency,
			workItemId: input.workItemId,
			projectId: input.projectId,
			cursor: input.cursor,
			limit: input.limit,
			observedAt,
		});
		return {
			data: page.data.map((row) => ({
				request: requestOutput(
					row.request,
					rowAttention(row),
					rowResolution(row),
				),
				effectiveState: row.effectiveState,
				canRespond: false,
				canCancel: false,
				workItem: row.workItem?.id ? row.workItem : null,
				responseCount: row.responseCount,
			})),
			nextCursor: page.nextCursor,
			hasMore: page.hasMore,
			observedAt,
		};
	},
);

function stringOrNull(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

/** Questions expire after a day; older answers are not worth delivering. */
const UNDELIVERED_WINDOW_MS = 24 * 60 * 60 * 1000;

const listUndeliveredProcedure = readOs.listUndelivered.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const caller = await verifiedActiveWorkActor(context, orgId);
		const observedAt = new Date().toISOString();
		const rows = await listUndeliveredWorkInteractionResponses(context.db, {
			orgId,
			actor: { type: caller.type, id: caller.id },
			respondedAfter:
				input.respondedAfter ??
				new Date(Date.now() - UNDELIVERED_WINDOW_MS).toISOString(),
			sessionId: input.sessionId,
			host: input.host,
			limit: input.limit,
		});
		return {
			data: rows.flatMap((row) =>
				row.sessionId
					? [
							{
								responseId: row.responseId,
								requestId: row.interactionId,
								subject: row.subject,
								body: row.body,
								respondedAt: row.respondedAt,
								sessionId: row.sessionId,
								host: row.host,
								workItemId: row.workItemId,
								projectId: row.projectId,
							},
						]
					: [],
			),
			observedAt,
		};
	},
);

const ackDeliveryProcedure = writeOs.ackDelivery.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const caller = await verifiedActiveWorkActor(context, orgId);
		if (input.via !== "handoff" && (input.handoffTo || input.handoffRef))
			throw createError(
				ErrorCodes.UNPROCESSABLE_CONTENT,
				"handoffTo and handoffRef are only valid with via=handoff",
			);
		const rows = await recordWorkInteractionDeliveries(context.db, {
			orgId,
			actor: { type: caller.type, id: caller.id },
			responseIds: input.responseIds,
			via: input.via,
			acknowledged: input.acknowledged,
			handoffTo: input.handoffTo,
			handoffRef: input.handoffRef,
			now: new Date().toISOString(),
		});
		return {
			data: rows.map((row) => ({
				responseId: row.responseId,
				requestId: row.interactionId,
				deliveredAt: row.deliveredAt,
				via: row.deliveredVia,
				acknowledgedAt: row.acknowledgedAt,
			})),
		};
	},
);

const recordDraftDeliveryProcedure = writeOs.recordDraftDelivery.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const caller = await verifiedActiveWorkActor(context, orgId);
		try {
			const recorded = await recordAutoReplyDelivery(context.db, {
				orgId,
				interactionId: input.requestId,
				draftId: input.draftId,
				actor: { type: caller.type, id: caller.id },
				via: input.via,
				responseId: crypto.randomUUID(),
				now: new Date().toISOString(),
			});
			const request = await getWorkInteraction(context.db, {
				orgId,
				interactionId: input.requestId,
			});
			if (!request)
				throw createError(ErrorCodes.NOT_FOUND, "Work interaction not found");
			if (recorded.created)
				await publishMcpInteractionResponse(context.env, {
					organizationId: orgId,
					requestId: request.id,
					responseId: recorded.response.id,
					respondedAt: recorded.response.respondedAt,
				});
			return {
				request: requestOutput(request),
				response: responseOutput(recorded.response),
				deliveredAt: recorded.deliveredAt,
				via: recorded.deliveredVia,
				created: recorded.created,
			};
		} catch (error) {
			rethrowInteractionError(error);
		}
	},
);

export const workInteractionsContractRouter = interactionsOs.router({
	create: createProcedure,
	respond: respondProcedure,
	delegate: delegateProcedure,
	cancel: cancelProcedure,
	get: getProcedure,
	listInbox: listInboxProcedure,
	listCliInboxProjection: listCliInboxProjectionProcedure,
	listOutbox: listOutboxProcedure,
	listAudit: listAuditProcedure,
	listUndelivered: listUndeliveredProcedure,
	ackDelivery: ackDeliveryProcedure,
	recordDraftDelivery: recordDraftDeliveryProcedure,
});

export type WorkInteractionsContractRouter =
	typeof workInteractionsContractRouter;
