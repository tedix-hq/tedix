import {
	ListWorkInteractionCliInboxResultSchema,
	WORK_PROPOSAL_SCHEMA,
	WorkProposalMetadataSchema,
} from "@tedix/api-contract/schemas/work-interactions";
import { call, implement } from "@orpc/server";
import { outboundRouter } from "./work-outbound";
import { outboundInteractionOverlays } from "@tedix/db/queries/work-items/outbound";
import { listExternalAgentSessionHarnessesByIds } from "@tedix/db/queries/external-agent-identity/session-state";
import { getMemberByUserId } from "@tedix/db/queries/organization-members";
import {
	getWorkItemBySourceIntentId,
	listWorkItemTitlesByShortIds,
} from "@tedix/db/queries/work-items/crud";
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
	reviewWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";
import {
	listUndeliveredWorkInteractionResponses,
	listWorkInteractionDeliveries,
	recordWorkInteractionDeliveries,
} from "@tedix/db/queries/work-items/interaction-deliveries";
import { listTediDisplayNamesByIds } from "@tedix/db/queries/tedis";
import { CAPTURE_HEALTH_SCHEMA } from "@tedix/db/queries/work-items/capture-health";
import {
	getLatestReplyDraft,
	listLatestReplyDrafts,
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
	/** The answer's own `metadata.delivery` ("none": a closure, never delivered). */
	delivery?: string | null;
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
	if (resolution.delivery === "none")
		return {
			state: "not_needed" as const,
			via: "none" as const,
			deliveredAt: resolution.deliveredAt,
			acknowledgedAt: resolution.acknowledgedAt,
			handoffTo: null,
		};
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
	const follow = row.metadata.followThrough;
	const reaskNote =
		follow &&
		typeof follow === "object" &&
		!Array.isArray(follow) &&
		typeof follow.reaskNote === "string"
			? follow.reaskNote
			: null;
	return {
		id: row.id,
		orgId: row.orgId,
		workItemId: row.workItemId,
		caseId: row.caseId,
		projectId: row.projectId,
		kind: row.kind,
		subject: row.subject,
		prompt: reaskNote
			? `${row.prompt.slice(0, 17_980)}\n\nFollow-up: ${reaskNote}`
			: row.prompt,
		requestedFromType: row.targetType,
		requestedFromId: row.targetId,
		creatorType: row.creatorType,
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
	const capturedWithoutTriage =
		input.metadata?.schema === "tedix.decision-capture.v1" &&
		(input.metadata.triage as { status?: string } | undefined)?.status !== "ok";
	if (capturedWithoutTriage && actor.type !== "external_agent")
		throw createError(
			ErrorCodes.UNPROCESSABLE_CONTENT,
			"Unclassified agent turns must stay on the agent's Work",
		);
	const target = capturedWithoutTriage ? actor : input.requestedFrom;
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
	let prompt = input.prompt;
	let lessonRecall:
		| import("@tedix/api-contract/schemas/common").JsonValue
		| undefined;
	const laneRequest = input.metadata?.laneRequest;
	if (
		input.kind === "handoff" &&
		laneRequest &&
		typeof laneRequest === "object" &&
		!Array.isArray(laneRequest) &&
		typeof laneRequest.harness === "string" &&
		laneRequest.harness.trim().length > 0 &&
		laneRequest.harness.length <= 40
	) {
		try {
			const { recallDispatchBrief } =
				await import("../../services/situational-recall");
			const recalled = await recallDispatchBrief(context, orgId, {
				brief: input.prompt,
				harness: String(laneRequest.harness),
				repo:
					typeof laneRequest.repo === "string" ? laneRequest.repo : undefined,
				targetUserId: target.type === "user" ? target.id : undefined,
			});
			prompt = recalled.prompt;
			lessonRecall = recalled.lessonRecall;
		} catch {
			lessonRecall = {
				status: "unavailable",
				dispatchPath: "tedix_interaction",
			};
		}
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
			prompt,
			notificationReason: input.notificationReason,
			reviewAfterDays: input.reviewAfterDays,
			creator: actor,
			targetType: target.type,
			targetId: target.id,
			dueAt: input.dueAt,
			expiresAt: input.expiresAt,
			metadata: {
				...input.metadata,
				...(lessonRecall ? { lessonRecall } : {}),
				...(actor.type === "external_agent"
					? {
							agentSession: actor.externalSessionKey,
							agentHarness: actor.externalSessionKey.split(":")[0]!,
						}
					: {}),
				...(input.reason ? { reason: input.reason } : {}),
			},
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
		if (context.waitUntil && created.targetType === "user" && created.targetId)
			context.waitUntil(
				(async () => {
					const { generateDecisionCard } =
						await import("../../services/decision-card-generator");
					const { saveDecisionCardPresentation } =
						await import("@tedix/db/queries/work-items/card-presentation");
					const presentation = await generateDecisionCard(context, created);
					if (presentation)
						await saveDecisionCardPresentation(context.db, {
							orgId,
							requestId: created.id,
							personId: created.targetId!,
							expectedVersion: created.version,
							presentation,
						});
				})().catch((error) =>
					console.warn("decision card generation failed", {
						requestId: created.id,
						error: String(error),
					}),
				),
			);
		return requestOutput(created);
	} catch (error) {
		rethrowInteractionError(error);
	}
});

/** Create before answering so a failed create leaves the proposal answerable. */
async function materializeWorkProposal(
	context: BaseContext,
	orgId: string,
	proposal: ReturnType<typeof WorkProposalMetadataSchema.parse>["proposal"],
) {
	const { createProcedure } = await import("./work-items/creation-reads");
	async function create(item: typeof proposal.item, parentWorkItemId?: string) {
		const lookup = () =>
			getWorkItemBySourceIntentId(context.db, {
				orgId,
				sourceIntentId: item.sourceIntentId,
			});
		const existing = await lookup();
		if (existing) return existing.id;
		try {
			const created = await call(
				createProcedure,
				{
					...item,
					workKind: "other",
					priority: "medium",
					projectId: proposal.projectId,
					parentWorkItemId,
					// Unfiled roots need a bounded purpose; children inherit theirs.
					workClass: parentWorkItemId ? undefined : "maintenance",
				},
				{ context },
			);
			return created.id;
		} catch (error) {
			// The unique source-intent index also arbitrates concurrent accepts.
			const winner = await lookup();
			if (winner) return winner.id;
			throw error;
		}
	}
	const itemId = await create(proposal.item, proposal.parentWorkItemId);
	const ids = [itemId];
	for (const child of proposal.children) ids.push(await create(child, itemId));
	return ids;
}

const respondProcedure = writeOs.respond.handler(async ({ input, context }) => {
	const orgId = requireOrgId(context);
	const actor = await verifiedActiveWorkActor(context, orgId);
	// Only the approved kernel execution forwards this authority on the trusted
	// MCP binding. Other Work writes still act as their authenticated principal.
	const approvingUserId =
		context.authType === "service-binding" && actor.type === "tedi"
			? context.headers.get("X-Tedix-Approved-Work-Responder")
			: null;
	let responder = actor;
	let startContext = context;
	if (approvingUserId) {
		const member = await getMemberByUserId(context.db, orgId, approvingUserId);
		if (member?.status !== "active" || !member.userId)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Approved Work responder must be an active organization user",
			);
		responder = { type: "user", id: member.userId };
		// The trusted approval delegates this start to the member, not the chat
		// tedi. Carry only their verified identity and current membership grants;
		// no token claims or machine headers survive into the nested procedures.
		startContext = {
			env: context.env,
			db: context.db,
			dbBookmark: context.dbBookmark,
			url: context.url,
			headers: new Headers(),
			rateLimiter: context.rateLimiter,
			waitUntil: context.waitUntil,
			organizationId: orgId,
			authType: "user",
			user: { sub: member.descopeUserId } as NonNullable<BaseContext["user"]>,
			userId: member.userId,
			userRole: member.role,
			userPermissionOverrides: member.customPermissions ?? [],
		};
	}
	try {
		let metadata = approvingUserId
			? { ...input.metadata, actor: { type: actor.type, id: actor.id } }
			: input.metadata;
		let body = input.body;
		if (input.responseKind === "handoff_accepted" && input.resolvesRequest) {
			const request = await getWorkInteraction(context.db, {
				orgId,
				interactionId: input.requestId,
			});
			if (
				request?.status === "open" &&
				request.kind === "handoff" &&
				request.targetType === "user" &&
				request.targetType === responder.type &&
				request.targetId === responder.id &&
				request.version === input.expectedRequestVersion &&
				(!request.expiresAt || request.expiresAt > new Date().toISOString())
			) {
				const parsed = WorkProposalMetadataSchema.safeParse(request.metadata);
				if (parsed.success) {
					const workItemIds = await materializeWorkProposal(
						context,
						orgId,
						parsed.data.proposal,
					);
					metadata = { ...metadata, workItemIds };
					const start = parsed.data.proposal.start;
					if (start && workItemIds[0]) {
						const { startAcceptedProposal } =
							await import("./work-items/proposal-start");
						const started = await startAcceptedProposal(startContext, {
							orgId,
							workItemId: workItemIds[0],
							start,
							responder,
						});
						metadata = { ...metadata, started };
						body = `${input.body}\n\n${started.summary} ${started.link}`.slice(
							0,
							20_000,
						);
					}
				}
			}
		}
		const { executeDecisionCardEffect } =
			await import("../../services/decision-card-effects");
		const decisionResponse = await executeDecisionCardEffect(context, {
			orgId,
			interactionId: input.requestId,
			expectedVersion: input.expectedRequestVersion,
			responder,
			responseKind: input.responseKind,
			body,
			artifactRef: input.artifactRef,
			artifactVersion: input.artifactVersion,
			artifactDigest: input.artifactDigest,
			resolvesRequest: input.resolvesRequest,
			metadata,
		});
		const response = await respondToWorkInteraction(context.db, {
			...decisionResponse,
			id: crypto.randomUUID(),
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
		if (!request.projectId && request.workItemId) {
			const { getWorkItemById } =
				await import("@tedix/db/queries/work-items/crud");
			const work = await getWorkItemById(
				context.db,
				request.workItemId,
				orgId,
			).catch((error: unknown) => {
				console.warn("[learning-feed] Work project enrichment unavailable", {
					workItemId: request.workItemId,
					error: error instanceof Error ? error.message : String(error),
				});
				return null;
			});
			if (work?.projectId) {
				const decisionContext = signal.metadata?.decisionContext;
				signal.metadata = {
					...signal.metadata,
					projectId: work.projectId,
					...(decisionContext &&
					typeof decisionContext === "object" &&
					!Array.isArray(decisionContext)
						? {
								decisionContext: {
									...decisionContext,
									projectId: work.projectId,
								},
							}
						: {}),
				};
			}
		}
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
			if (request.metadata.schema === "tedix.decision-capture.v1")
				throw createError(
					ErrorCodes.FORBIDDEN,
					"Session questions are private to their participants",
				);
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
		const [outbound] = await outboundInteractionOverlays(context.db, orgId, [
			request.id,
		]);
		return {
			request: requestOutput(
				outbound
					? {
							...request,
							subject: outbound.subject,
							metadata: {
								...request.metadata,
								schema: "tedix.outbound.v1",
								outboundWorkItemId: outbound.workItemId,
								outboundStatus: outbound.status,
							},
						}
					: request,
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

type RequestOutput = ReturnType<typeof requestOutput>;

/** 8-character Work Item short ids quoted in the lines a person reads. */
function quotedShortIds(request: RequestOutput): string[] {
	const metadata = request.metadata as Record<string, unknown>;
	const text = [request.subject, metadata.neededFromYou, metadata.reason]
		.filter((value): value is string => typeof value === "string")
		.join(" ");
	return [...text.matchAll(/\b[0-9a-f]{8}\b/gi)].map((match) =>
		match[0].toLowerCase(),
	);
}

const AGENT_HOSTS: Record<string, string> = {
	"claude-code": "Claude Code session",
	codex: "Codex session",
};

function creatorHarness(
	request: RequestOutput,
	sessionHarnesses: ReadonlyMap<
		string,
		{ principalId: string; harness: string }
	>,
): string | null {
	if (request.creatorType === "tedi") return null;
	const metadata = request.metadata as Record<string, unknown>;
	const session =
		typeof metadata.agentSession === "string"
			? metadata.agentSession
			: request.creatorSessionId;
	const storedSession = sessionHarnesses.get(request.creatorSessionId ?? "");
	const verifiedHost =
		request.creatorType === "external_agent" &&
		storedSession?.principalId === request.creatorId
			? storedSession.harness
			: undefined;
	const host =
		verifiedHost ??
		(typeof metadata.host === "string"
			? metadata.host
			: session
				? typeof metadata.agentHarness === "string"
					? metadata.agentHarness
					: session.split(":")[0]
				: null);
	return host && !/^[0-9a-f-]{36}$/i.test(host) ? host : null;
}

/** Who asked, in plain words, for the person deciding what to do with it. */
function askedBy(
	request: RequestOutput,
	callerId: string,
	tediNames: ReadonlyMap<string, string>,
	sessionHarnesses: ReadonlyMap<
		string,
		{ principalId: string; harness: string }
	>,
): string {
	const metadata = request.metadata as Record<string, unknown>;
	if (metadata.schema === WORK_PROPOSAL_SCHEMA)
		return metadata.source === "tedix learn" ? "Onboarding" : "Tedix";
	if (metadata.schema === CAPTURE_HEALTH_SCHEMA) return "Tedix";
	if (request.creatorType === "tedi")
		return tediNames.get(request.creatorId) ?? "A tedi";
	const host = creatorHarness(request, sessionHarnesses);
	if (host) return AGENT_HOSTS[host] ?? host;
	if (request.creatorType === "external_agent") return "Your coding assistant";
	return request.creatorId === callerId ? "You" : "A teammate";
}

const listInboxProcedure = readOs.listInbox.handler(
	async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const caller = await verifiedActiveWorkActor(context, orgId);
		const observedAt = new Date().toISOString();
		const page = await listWorkInteractionInbox(context.db, {
			orgId,
			states: input.states,
			kinds: input.kinds,
			decisionKind: input.decisionKind,
			urgency: input.urgency,
			workItemId: input.workItemId,
			projectId: input.projectId,
			targetType: caller.type,
			targetId: caller.id,
			cursor: input.cursor,
			limit: input.limit,
			observedAt,
		});
		const outbound = new Map(
			(
				await outboundInteractionOverlays(
					context.db,
					orgId,
					page.data.map((row) => row.request.id),
				)
			).map((overlay) => [overlay.interactionId, overlay]),
		);
		const requests = page.data.map((row) => {
			const overlay = outbound.get(row.request.id);
			return requestOutput(
				overlay
					? {
							...row.request,
							subject: overlay.subject,
							metadata: {
								...row.request.metadata,
								schema: "tedix.outbound.v1",
								outboundWorkItemId: overlay.workItemId,
								outboundStatus: overlay.status,
							},
						}
					: row.request,
				rowAttention(row),
				rowResolution(row),
			);
		});
		const [tedis, references, sessions, drafts] = await Promise.all([
			listTediDisplayNamesByIds(context.db, {
				organizationId: orgId,
				ids: requests
					.filter((request) => request.creatorType === "tedi")
					.map((request) => request.creatorId),
			}),
			listWorkItemTitlesByShortIds(context.db, {
				orgId,
				shortIds: requests.flatMap(quotedShortIds),
			}),
			listExternalAgentSessionHarnessesByIds(context.db, {
				organizationId: orgId,
				sessionIds: requests
					.filter(
						(request) =>
							request.creatorType === "external_agent" &&
							/^[0-9a-f-]{36}$/i.test(request.creatorSessionId ?? ""),
					)
					.map((request) => request.creatorSessionId!),
			}),
			listLatestReplyDrafts(
				context.db,
				orgId,
				requests.map((request) => request.id),
			),
		]);
		const tediNames = new Map(
			tedis.map((tedi) => [tedi.id, tedi.displayName ?? tedi.name]),
		);
		const sessionHarnesses = new Map(
			sessions.map((session) => [session.id, session]),
		);
		return {
			data: page.data.map((row, index) => {
				const request = requests[index] as (typeof requests)[number];
				const quoted = new Set(quotedShortIds(request));
				const draft = drafts.find(
					(draft) => draft.interactionId === request.id,
				);
				return {
					request,
					effectiveState: row.effectiveState,
					canRespond: row.effectiveState === "open",
					canCancel: false,
					outbound: outbound.get(request.id)?.record,
					latestDraft: draft
						? {
								id: draft.id,
								body: draft.body,
								rationale: draft.rationale,
								drafterId: draft.drafterId,
								drafterName: tediNames.get(draft.drafterId) ?? null,
								createdAt: draft.createdAt,
								turnType: draft.turnType,
								delivery: draft.delivery,
								gate: storedGate(draft.gate),
							}
						: null,
					workItem: row.workItem?.id ? row.workItem : null,
					responseCount: row.responseCount,
					askedBy: askedBy(request, caller.id, tediNames, sessionHarnesses),
					creatorHarness: creatorHarness(request, sessionHarnesses),
					references: references.filter((ref) => quoted.has(ref.shortId)),
				};
			}),
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
			excludeSessionCapture: true,
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
	outbound: outboundRouter,
	regenerateCard: writeOs.regenerateCard.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const actor = await verifiedActiveWorkActor(context, orgId);
		const request = await getWorkInteraction(context.db, {
			orgId,
			interactionId: input.requestId,
		});
		if (
			!request ||
			actor.type !== "user" ||
			request.targetType !== "user" ||
			request.targetId !== actor.id
		)
			throw createError(
				ErrorCodes.FORBIDDEN,
				"Only the addressed person can regenerate this card",
			);
		if (
			request.version !== input.expectedRequestVersion ||
			effectiveState(request, new Date().toISOString()) !== "open"
		)
			throw createError(
				ErrorCodes.CONFLICT,
				"The request changed; read it again",
			);
		const { generateDecisionCard } =
			await import("../../services/decision-card-generator");
		let failure = "unknown";
		const presentation = await generateDecisionCard(
			context,
			request,
			(reason) => {
				failure = reason;
			},
		);
		if (!presentation)
			throw createError(
				ErrorCodes.SERVICE_UNAVAILABLE,
				`The card generator could not produce valid copy (${failure})`,
			);
		const { saveDecisionCardPresentation } =
			await import("@tedix/db/queries/work-items/card-presentation");
		const saved = await saveDecisionCardPresentation(context.db, {
			orgId,
			requestId: request.id,
			personId: actor.id,
			expectedVersion: input.expectedRequestVersion,
			presentation,
		});
		if (!saved)
			throw createError(
				ErrorCodes.CONFLICT,
				"The request changed during generation",
			);
		return requestOutput(saved);
	}),
	create: createProcedure,
	review: writeOs.review.handler(async ({ input, context }) => {
		const orgId = requireOrgId(context);
		const actor = await verifiedActiveWorkActor(context, orgId);
		try {
			return requestOutput(
				await reviewWorkInteraction(context.db, {
					orgId,
					interactionId: input.requestId,
					expectedVersion: input.expectedRequestVersion,
					actor,
					action: input.action,
					note: input.note,
					responseId: input.responseId,
					evidenceId: input.evidenceId,
					now: new Date().toISOString(),
				}),
			);
		} catch (error) {
			rethrowInteractionError(error);
		}
	}),
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
