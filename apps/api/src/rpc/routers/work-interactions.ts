import { implement } from "@orpc/server";
import { workInteractionsContract } from "@tedix/api-contract/contracts/work-interactions";
import {
	cancelWorkInteraction,
	createWorkInteraction,
	delegateWorkInteraction,
	getWorkInteraction,
	listWorkInteractionInbox,
	listWorkInteractionResponses,
	respondToWorkInteraction,
} from "@tedix/db/queries/work-items/interactions";
import { listTediDisplayNamesByIds } from "@tedix/db/queries/tedis";
import { getLatestReplyDraft } from "@tedix/db/queries/work-items/reply-drafts";
import { publishMcpInteractionResponse } from "../../lib/mcp-subscriptions";
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
function requestOutput(row: InteractionRow) {
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
		metadata: row.metadata,
	};
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
		return requestOutput(
			await createWorkInteraction(context.db, {
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
			}),
		);
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
		return {
			request: requestOutput(request),
			response: responseOutput(response),
		};
	} catch (error) {
		rethrowInteractionError(error);
	}
});

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
		const [rows, latestDraft] = await Promise.all([
			listWorkInteractionResponses(context.db, {
				orgId,
				interactionId: request.id,
				limit: input.responseLimit + 1,
				afterRespondedAt: input.responseCursor?.at,
				afterId: input.responseCursor?.id,
			}),
			getLatestReplyDraft(context.db, { orgId, interactionId: request.id }),
		]);
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
			request: requestOutput(request),
			effectiveState: state,
			canRespond: isTarget && state === "open",
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
				request: requestOutput(row.request),
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
				request: requestOutput(row.request),
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
				request: requestOutput(row.request),
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

export const workInteractionsContractRouter = interactionsOs.router({
	create: createProcedure,
	respond: respondProcedure,
	delegate: delegateProcedure,
	cancel: cancelProcedure,
	get: getProcedure,
	listInbox: listInboxProcedure,
	listOutbox: listOutboxProcedure,
	listAudit: listAuditProcedure,
});

export type WorkInteractionsContractRouter =
	typeof workInteractionsContractRouter;
