import { implement } from "@orpc/server";
import { memoryEntitiesContract } from "@tedix/api-contract/contracts/memory-entities";
import { isPlatformPrincipal } from "@tedix/auth/types";
import type { MemoryEntityActor } from "@tedix/db/queries/memory-entities";
import { toJsonRecord } from "@tedix/db/utils/json";
import { requireOrgId } from "../org-scope";
import {
	AUTHZ,
	type BaseContext,
	createError,
	ErrorCodes,
	withAuth,
} from "../orpc";

const memoryEntitiesOs = implement(
	memoryEntitiesContract,
).$context<BaseContext>();
const authed = memoryEntitiesOs.use(withAuth);

/**
 * Stable, server-verified governance identity. API keys deliberately collapse
 * to their organization root so minting a second key cannot manufacture
 * proposer/reviewer independence.
 */
export function resolveMemoryEntityActor(
	context: Pick<
		BaseContext,
		| "apiKey"
		| "authType"
		| "externalAgentPrincipalId"
		| "organizationId"
		| "serviceAccount"
		| "tediId"
		| "user"
	>,
): MemoryEntityActor | null {
	if (context.externalAgentPrincipalId) {
		return {
			type: "external_agent",
			id: context.externalAgentPrincipalId,
		};
	}
	if (context.tediId) {
		return { type: "tedi", id: context.tediId };
	}
	if (typeof context.user?.sub === "string" && context.user.sub.length > 0) {
		return { type: "user", id: context.user.sub };
	}
	if (context.apiKey?.id) {
		const organizationId =
			context.organizationId ?? context.apiKey.organizationId;
		return organizationId
			? { type: "api_key", id: `organization:${organizationId}` }
			: null;
	}
	if (context.serviceAccount?.clientId) {
		return { type: "service", id: context.serviceAccount.clientId };
	}
	if (context.authType === "service-binding" && context.organizationId) {
		return {
			type: "service",
			id: `${context.authType}:organization:${context.organizationId}`,
		};
	}
	return null;
}

function requireMemoryEntityActor(context: BaseContext): MemoryEntityActor {
	const actor = resolveMemoryEntityActor(context);
	if (actor) return actor;
	throw createError(
		ErrorCodes.FORBIDDEN,
		"A stable authenticated principal is required for entity evidence",
	);
}

/**
 * Canonical entity creation and adjudication are restricted to accountable
 * organizational governors. External agents may propose but can never pass
 * this gate, even when their request arrived through a privileged binding.
 */
export function hasMemoryEntityGovernanceAuthority(
	context: Pick<
		BaseContext,
		| "apiKey"
		| "authType"
		| "externalAgentPrincipalId"
		| "tediId"
		| "tediScopes"
		| "user"
		| "userRole"
	>,
): boolean {
	if (context.externalAgentPrincipalId) return false;
	if (context.tediId) {
		const scopes = context.tediScopes ?? [];
		return (
			scopes.includes("*") ||
			scopes.includes("platform:admin") ||
			scopes.includes("mcp:memory.admin")
		);
	}
	if (context.authType === "user") {
		return (
			context.userRole === "owner" ||
			context.userRole === "admin" ||
			Boolean(context.user && isPlatformPrincipal({ user: context.user }))
		);
	}
	if (context.authType === "apikey") {
		const scopes = context.apiKey?.scopes ?? [];
		return (
			scopes.includes("*") ||
			scopes.includes("platform:admin") ||
			scopes.includes("platform:admin")
		);
	}
	return false;
}

function requireMemoryEntityGovernor(context: BaseContext): MemoryEntityActor {
	if (!hasMemoryEntityGovernanceAuthority(context)) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Canonical entity governance requires an owner/admin, a platform-scoped API key, or an accountable tedi with memory-admin authority",
		);
	}
	const actor = requireMemoryEntityActor(context);
	if (
		actor.type !== "user" &&
		actor.type !== "api_key" &&
		actor.type !== "tedi"
	) {
		throw createError(
			ErrorCodes.FORBIDDEN,
			"Canonical entity governance requires an accountable user, API-key organization root, or tedi",
		);
	}
	return actor;
}

function rethrowMemoryEntityError(error: unknown): never {
	if (
		!(error instanceof Error) ||
		error.name !== "MemoryEntityGovernanceError"
	) {
		throw error;
	}
	const reason = (error as Error & { reason?: string }).reason;
	switch (reason) {
		case "entity_not_found":
		case "mention_not_found":
		case "proposal_not_found":
		case "source_fact_not_found":
			throw createError(ErrorCodes.NOT_FOUND, error.message, error);
		case "invalid_operation":
			throw createError(ErrorCodes.BAD_REQUEST, error.message, error);
		case "wrong_org":
			throw createError(ErrorCodes.FORBIDDEN, error.message, error);
		case "entity_inactive":
		case "immutable_mention_conflict":
		case "no_state_change":
		case "proposal_conflict":
		case "review_conflict":
		case "reviewer_not_independent":
		case "state_changed":
			throw createError(ErrorCodes.CONFLICT, error.message, error);
	}
	throw error;
}

const createEntity = authed.createEntity
	.use(AUTHZ.memoryWrite)
	.handler(async ({ input, context }) => {
		requireMemoryEntityGovernor(context);
		try {
			const { createMemoryEntity } =
				await import("@tedix/db/queries/memory-entities");
			return await createMemoryEntity(context.db, {
				id: input.entityId ?? crypto.randomUUID(),
				organizationId: requireOrgId(context),
				entityType: input.entityType,
				displayName: input.displayName,
				normalizedName: input.normalizedName,
				now: new Date().toISOString(),
			});
		} catch (error) {
			rethrowMemoryEntityError(error);
		}
	});

const recordMention = authed.recordMention
	.use(AUTHZ.memoryWrite)
	.handler(async ({ input, context }) => {
		requireMemoryEntityActor(context);
		try {
			const { recordMemoryEntityMention } =
				await import("@tedix/db/queries/memory-entities");
			return await recordMemoryEntityMention(context.db, {
				id: input.mentionId,
				organizationId: requireOrgId(context),
				occurrenceKey: input.occurrenceKey,
				sourceFactId: input.sourceFactId,
				sourceUri: input.sourceUri,
				sourceContentHash: input.sourceContentHash,
				sourceSessionId: input.sourceSessionId,
				sourceRunId: input.sourceRunId,
				surfaceForm: input.surfaceForm,
				normalizedForm: input.normalizedForm,
				proposedType: input.proposedType,
				charStart: input.charStart,
				charEnd: input.charEnd,
				extractor: input.extractor,
				extractorVersion: input.extractorVersion,
				modelId: input.modelId,
				harnessVersionId: input.harnessVersionId,
				confidence: input.confidence,
				evidence:
					input.evidence === undefined
						? undefined
						: toJsonRecord(input.evidence),
				createdAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowMemoryEntityError(error);
		}
	});

const listCandidates = authed.listCandidates
	.use(AUTHZ.memoryRead)
	.handler(async ({ input, context }) => {
		const { listMemoryEntityCandidates } =
			await import("@tedix/db/queries/memory-entities");
		return {
			candidates: await listMemoryEntityCandidates(context.db, {
				organizationId: requireOrgId(context),
				surface: input.surface,
				entityType: input.entityType,
				limit: input.limit,
			}),
		};
	});

const proposeResolution = authed.proposeResolution
	.use(AUTHZ.memoryWrite)
	.handler(async ({ input, context }) => {
		const actor = requireMemoryEntityActor(context);
		try {
			const { proposeMemoryEntityResolution } =
				await import("@tedix/db/queries/memory-entities");
			return await proposeMemoryEntityResolution(context.db, {
				id: input.decisionId,
				organizationId: requireOrgId(context),
				clientProposalKey: input.clientProposalKey,
				mentionId: input.mentionId,
				targetEntityId: input.targetEntityId,
				confidence: input.confidence,
				rationale: input.rationale,
				evidence:
					input.evidence === undefined
						? undefined
						: toJsonRecord(input.evidence),
				proposedBy: actor,
				sourceRunId: input.sourceRunId,
				proposedAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowMemoryEntityError(error);
		}
	});

const proposeResolutionRollback = authed.proposeResolutionRollback
	.use(AUTHZ.memoryWrite)
	.handler(async ({ input, context }) => {
		const actor = requireMemoryEntityActor(context);
		try {
			const { proposeMemoryEntityResolutionRollback } =
				await import("@tedix/db/queries/memory-entities");
			return await proposeMemoryEntityResolutionRollback(context.db, {
				id: input.decisionId,
				organizationId: requireOrgId(context),
				clientProposalKey: input.clientProposalKey,
				rollbackOfDecisionId: input.rollbackOfDecisionId,
				rationale: input.rationale,
				evidence:
					input.evidence === undefined
						? undefined
						: toJsonRecord(input.evidence),
				proposedBy: actor,
				sourceRunId: input.sourceRunId,
				proposedAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowMemoryEntityError(error);
		}
	});

const reviewResolution = authed.reviewResolution
	.use(AUTHZ.memoryWrite)
	.handler(async ({ input, context }) => {
		const reviewer = requireMemoryEntityGovernor(context);
		if (input.outcome === "accept" && !input.resolutionId) {
			throw createError(
				ErrorCodes.BAD_REQUEST,
				"resolutionId is required when accepting",
			);
		}
		try {
			const { reviewMemoryEntityResolutionProposal } =
				await import("@tedix/db/queries/memory-entities");
			return await reviewMemoryEntityResolutionProposal(context.db, {
				organizationId: requireOrgId(context),
				decisionId: input.decisionId,
				expectedDecisionVersion: input.expectedDecisionVersion,
				outcome: input.outcome,
				reviewer,
				reviewRationale: input.reviewRationale,
				resolutionId: input.resolutionId,
				reviewedAt: new Date().toISOString(),
			});
		} catch (error) {
			rethrowMemoryEntityError(error);
		}
	});

const getMentionResolution = authed.getMentionResolution
	.use(AUTHZ.memoryRead)
	.handler(async ({ input, context }) => {
		const organizationId = requireOrgId(context);
		const { getMemoryEntityMentionState, listMemoryEntityResolutionDecisions } =
			await import("@tedix/db/queries/memory-entities");
		const state = await getMemoryEntityMentionState(context.db, {
			organizationId,
			mentionId: input.mentionId,
		});
		if (!state) {
			throw createError(ErrorCodes.NOT_FOUND, "Entity mention was not found");
		}
		return {
			...state,
			history: await listMemoryEntityResolutionDecisions(context.db, {
				organizationId,
				mentionId: input.mentionId,
				limit: input.historyLimit,
			}),
		};
	});

export const memoryEntitiesContractRouter = memoryEntitiesOs.router({
	createEntity,
	recordMention,
	listCandidates,
	proposeResolution,
	proposeResolutionRollback,
	reviewResolution,
	getMentionResolution,
});
