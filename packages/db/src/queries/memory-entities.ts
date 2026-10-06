import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { and, eq, exists, inArray, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import {
	type MemoryEntity,
	type MemoryEntityActorType,
	type MemoryEntityMention,
	type MemoryEntityResolution,
	type MemoryEntityResolutionDecision,
	type MemoryEntityResolutionInverse,
	type MemoryEntityType,
	memoryEntities,
	memoryEntityAliases,
	memoryEntityMentions,
	memoryEntityResolutionDecisions,
	memoryEntityResolutionHeads,
	memoryEntityResolutions,
} from "../schema/memory-entities";
import { memoryFacts } from "../schema/memory-graph";

export type MemoryEntityGovernanceErrorReason =
	| "entity_inactive"
	| "entity_not_found"
	| "immutable_mention_conflict"
	| "invalid_operation"
	| "mention_not_found"
	| "no_state_change"
	| "proposal_conflict"
	| "proposal_not_found"
	| "review_conflict"
	| "reviewer_not_independent"
	| "source_fact_not_found"
	| "state_changed"
	| "wrong_org";

export class MemoryEntityGovernanceError extends Error {
	constructor(
		readonly reason: MemoryEntityGovernanceErrorReason,
		message: string,
	) {
		super(message);
		this.name = "MemoryEntityGovernanceError";
	}
}

export interface MemoryEntityActor {
	type: MemoryEntityActorType;
	id: string;
}

export function normalizeMemoryEntitySurface(value: string): string {
	return value
		.normalize("NFKC")
		.trim()
		.replace(/\s+/g, " ")
		.toLocaleLowerCase();
}

function stableJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map((item) => stableJson(item)).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "undefined";
}

export async function createMemoryEntity(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		entityType: MemoryEntityType;
		displayName: string;
		normalizedName?: string;
		now: string;
	},
): Promise<MemoryEntity> {
	const normalizedName =
		input.normalizedName ?? normalizeMemoryEntitySurface(input.displayName);
	const [created] = await db
		.insert(memoryEntities)
		.values({
			id: input.id,
			organizationId: input.organizationId,
			entityType: input.entityType,
			displayName: input.displayName.trim(),
			normalizedName,
			status: "active",
			version: 0,
			createdAt: input.now,
			updatedAt: input.now,
		})
		.onConflictDoNothing()
		.returning();
	if (created) return created;
	const [existing] = await db
		.select()
		.from(memoryEntities)
		.where(
			and(
				eq(memoryEntities.organizationId, input.organizationId),
				eq(memoryEntities.id, input.id),
			),
		)
		.limit(1);
	if (
		existing &&
		existing.entityType === input.entityType &&
		existing.displayName === input.displayName.trim() &&
		existing.normalizedName === normalizedName
	) {
		return existing;
	}
	throw new MemoryEntityGovernanceError(
		"proposal_conflict",
		"Entity id already identifies a different canonical entity",
	);
}

export async function getMemoryEntity(
	db: DbClient,
	input: { organizationId: string; entityId: string },
): Promise<MemoryEntity | null> {
	const [row] = await db
		.select()
		.from(memoryEntities)
		.where(
			and(
				eq(memoryEntities.organizationId, input.organizationId),
				eq(memoryEntities.id, input.entityId),
			),
		)
		.limit(1);
	return row ?? null;
}

export interface MemoryEntityCandidate {
	entity: MemoryEntity;
	matchedBy: "canonical" | "alias";
	aliasId: string | null;
}

/**
 * Exact, normalized candidate lookup only. Fuzzy/semantic candidate generation
 * belongs in the retrieval layer; this bounded D1 read is the deterministic
 * canonical-name and confirmed-alias fence used by resolution tooling.
 */
export async function listMemoryEntityCandidates(
	db: DbClient,
	input: {
		organizationId: string;
		surface: string;
		entityType?: MemoryEntityType;
		limit?: number;
	},
): Promise<MemoryEntityCandidate[]> {
	const normalized = normalizeMemoryEntitySurface(input.surface);
	const limit = Math.max(1, Math.min(100, Math.trunc(input.limit ?? 25)));
	const entityTypeCondition = input.entityType
		? eq(memoryEntities.entityType, input.entityType)
		: sql`1 = 1`;
	const canonical = await db
		.select({ entity: memoryEntities })
		.from(memoryEntities)
		.where(
			and(
				eq(memoryEntities.organizationId, input.organizationId),
				eq(memoryEntities.status, "active"),
				eq(memoryEntities.normalizedName, normalized),
				entityTypeCondition,
			),
		)
		.limit(limit);
	const aliases = await db
		.select({
			aliasId: memoryEntityAliases.id,
			entityId: memoryEntityAliases.entityId,
		})
		.from(memoryEntityAliases)
		.where(
			and(
				eq(memoryEntityAliases.organizationId, input.organizationId),
				eq(memoryEntityAliases.normalizedForm, normalized),
				eq(memoryEntityAliases.reviewStatus, "confirmed"),
				isNull(memoryEntityAliases.validTo),
			),
		)
		.limit(limit);

	const candidates = new Map<string, MemoryEntityCandidate>();
	for (const row of canonical) {
		candidates.set(row.entity.id, {
			entity: row.entity,
			matchedBy: "canonical",
			aliasId: null,
		});
	}
	const aliasByEntityId = new Map(
		aliases.map((row) => [row.entityId, row.aliasId]),
	);
	const aliasEntityIds = [...aliasByEntityId.keys()].filter(
		(entityId) => !candidates.has(entityId),
	);
	if (aliasEntityIds.length > 0) {
		const aliasEntities = await db
			.select()
			.from(memoryEntities)
			.where(
				and(
					eq(memoryEntities.organizationId, input.organizationId),
					inArray(memoryEntities.id, aliasEntityIds),
					eq(memoryEntities.status, "active"),
					entityTypeCondition,
				),
			)
			.limit(limit);
		for (const entity of aliasEntities) {
			candidates.set(entity.id, {
				entity,
				matchedBy: "alias",
				aliasId: aliasByEntityId.get(entity.id) ?? null,
			});
		}
	}
	return [...candidates.values()].slice(0, limit);
}

function sameImmutableMention(
	existing: MemoryEntityMention,
	input: {
		id: string;
		organizationId: string;
		occurrenceKey: string;
		sourceFactId?: string | null;
		sourceUri?: string | null;
		sourceContentHash?: string | null;
		sourceSessionId?: string | null;
		sourceRunId?: string | null;
		surfaceForm: string;
		normalizedForm?: string;
		proposedType: MemoryEntityType;
		charStart?: number | null;
		charEnd?: number | null;
		extractor: string;
		extractorVersion: string;
		modelId?: string | null;
		harnessVersionId?: string | null;
		confidence: number;
		evidence?: Record<string, JsonValue>;
		createdAt: string;
	},
): boolean {
	return (
		existing.id === input.id &&
		existing.organizationId === input.organizationId &&
		existing.occurrenceKey === input.occurrenceKey &&
		existing.sourceFactId === (input.sourceFactId ?? null) &&
		existing.sourceUri === (input.sourceUri ?? null) &&
		existing.sourceContentHash === (input.sourceContentHash ?? null) &&
		existing.sourceSessionId === (input.sourceSessionId ?? null) &&
		existing.sourceRunId === (input.sourceRunId ?? null) &&
		existing.surfaceForm === input.surfaceForm &&
		existing.normalizedForm ===
			(input.normalizedForm ??
				normalizeMemoryEntitySurface(input.surfaceForm)) &&
		existing.proposedType === input.proposedType &&
		existing.charStart === (input.charStart ?? null) &&
		existing.charEnd === (input.charEnd ?? null) &&
		existing.extractor === input.extractor &&
		existing.extractorVersion === input.extractorVersion &&
		existing.modelId === (input.modelId ?? null) &&
		existing.harnessVersionId === (input.harnessVersionId ?? null) &&
		existing.confidence === input.confidence &&
		stableJson(existing.evidence) === stableJson(input.evidence ?? {})
	);
}

async function getMentionByOccurrence(
	db: DbClient,
	organizationId: string,
	occurrenceKey: string,
): Promise<MemoryEntityMention | null> {
	const [row] = await db
		.select()
		.from(memoryEntityMentions)
		.where(
			and(
				eq(memoryEntityMentions.organizationId, organizationId),
				eq(memoryEntityMentions.occurrenceKey, occurrenceKey),
			),
		)
		.limit(1);
	return row ?? null;
}

/**
 * Idempotent insert-only ingestion. The database triggers exported by the
 * schema reject UPDATE and DELETE even when a caller bypasses this module.
 */
export async function recordMemoryEntityMention(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		occurrenceKey: string;
		sourceFactId?: string | null;
		sourceUri?: string | null;
		sourceContentHash?: string | null;
		sourceSessionId?: string | null;
		sourceRunId?: string | null;
		surfaceForm: string;
		normalizedForm?: string;
		proposedType: MemoryEntityType;
		charStart?: number | null;
		charEnd?: number | null;
		extractor: string;
		extractorVersion: string;
		modelId?: string | null;
		harnessVersionId?: string | null;
		confidence: number;
		evidence?: Record<string, JsonValue>;
		createdAt: string;
	},
): Promise<MemoryEntityMention> {
	if (input.sourceFactId) {
		const [sourceFact] = await db
			.select({ id: memoryFacts.id })
			.from(memoryFacts)
			.where(
				and(
					eq(memoryFacts.id, input.sourceFactId),
					eq(memoryFacts.organizationId, input.organizationId),
				),
			)
			.limit(1);
		if (!sourceFact) {
			throw new MemoryEntityGovernanceError(
				"source_fact_not_found",
				"Source fact does not exist in this organization",
			);
		}
	}

	const existing = await getMentionByOccurrence(
		db,
		input.organizationId,
		input.occurrenceKey,
	);
	if (existing) {
		if (!sameImmutableMention(existing, input)) {
			throw new MemoryEntityGovernanceError(
				"immutable_mention_conflict",
				"Occurrence key already identifies different immutable evidence",
			);
		}
		await db
			.insert(memoryEntityResolutionHeads)
			.values({
				mentionId: existing.id,
				organizationId: existing.organizationId,
				version: 0,
				updatedAt: existing.createdAt,
			})
			.onConflictDoNothing();
		return existing;
	}

	const normalizedForm =
		input.normalizedForm ?? normalizeMemoryEntitySurface(input.surfaceForm);
	try {
		const [mentions] = await db.batch([
			db
				.insert(memoryEntityMentions)
				.values({
					...input,
					normalizedForm,
					sourceFactId: input.sourceFactId ?? null,
					sourceUri: input.sourceUri ?? null,
					sourceContentHash: input.sourceContentHash ?? null,
					sourceSessionId: input.sourceSessionId ?? null,
					sourceRunId: input.sourceRunId ?? null,
					charStart: input.charStart ?? null,
					charEnd: input.charEnd ?? null,
					modelId: input.modelId ?? null,
					harnessVersionId: input.harnessVersionId ?? null,
					evidence: input.evidence ?? {},
				})
				.returning(),
			db
				.insert(memoryEntityResolutionHeads)
				.values({
					mentionId: input.id,
					organizationId: input.organizationId,
					version: 0,
					updatedAt: input.createdAt,
				})
				.returning(),
		]);
		const mention = mentions[0];
		if (!mention) throw new Error("Mention insert returned no row");
		return mention;
	} catch (error) {
		const raced = await getMentionByOccurrence(
			db,
			input.organizationId,
			input.occurrenceKey,
		);
		if (raced && sameImmutableMention(raced, input)) return raced;
		if (raced) {
			throw new MemoryEntityGovernanceError(
				"immutable_mention_conflict",
				"Occurrence key was concurrently bound to different evidence",
			);
		}
		throw error;
	}
}

async function getMentionAndHead(
	db: DbClient,
	organizationId: string,
	mentionId: string,
) {
	const [mention] = await db
		.select()
		.from(memoryEntityMentions)
		.where(
			and(
				eq(memoryEntityMentions.organizationId, organizationId),
				eq(memoryEntityMentions.id, mentionId),
			),
		)
		.limit(1);
	const [head] = await db
		.select()
		.from(memoryEntityResolutionHeads)
		.where(
			and(
				eq(memoryEntityResolutionHeads.organizationId, organizationId),
				eq(memoryEntityResolutionHeads.mentionId, mentionId),
			),
		)
		.limit(1);
	if (!mention || !head) {
		throw new MemoryEntityGovernanceError(
			"mention_not_found",
			"Mention or its resolution head was not found",
		);
	}
	return { mention, head };
}

export async function getMemoryEntityMentionState(
	db: DbClient,
	input: { organizationId: string; mentionId: string },
): Promise<{
	mention: MemoryEntityMention;
	head: typeof memoryEntityResolutionHeads.$inferSelect;
	currentResolution: MemoryEntityResolution | null;
} | null> {
	let row: Awaited<ReturnType<typeof getMentionAndHead>>;
	try {
		row = await getMentionAndHead(db, input.organizationId, input.mentionId);
	} catch (error) {
		if (
			error instanceof MemoryEntityGovernanceError &&
			error.reason === "mention_not_found"
		) {
			return null;
		}
		throw error;
	}
	return {
		...row,
		currentResolution: await getResolutionById(
			db,
			input.organizationId,
			row.head.currentResolutionId,
		),
	};
}

async function requireActiveEntity(
	db: DbClient,
	organizationId: string,
	entityId: string,
): Promise<MemoryEntity> {
	const [entity] = await db
		.select()
		.from(memoryEntities)
		.where(
			and(
				eq(memoryEntities.organizationId, organizationId),
				eq(memoryEntities.id, entityId),
			),
		)
		.limit(1);
	if (!entity) {
		throw new MemoryEntityGovernanceError(
			"entity_not_found",
			"Entity was not found in this organization",
		);
	}
	if (entity.status !== "active") {
		throw new MemoryEntityGovernanceError(
			"entity_inactive",
			`Entity is ${entity.status}`,
		);
	}
	return entity;
}

async function getResolutionById(
	db: DbClient,
	organizationId: string,
	resolutionId: string | null,
): Promise<MemoryEntityResolution | null> {
	if (!resolutionId) return null;
	const [row] = await db
		.select()
		.from(memoryEntityResolutions)
		.where(
			and(
				eq(memoryEntityResolutions.organizationId, organizationId),
				eq(memoryEntityResolutions.id, resolutionId),
			),
		)
		.limit(1);
	return row ?? null;
}

function sameProposal(
	existing: MemoryEntityResolutionDecision,
	input: {
		id: string;
		operation: MemoryEntityResolutionDecision["operation"];
		mentionId: string;
		targetEntityId: string | null;
		proposedBy: MemoryEntityActor;
		confidence: number;
		rationale: string;
	},
): boolean {
	return (
		existing.id === input.id &&
		existing.operation === input.operation &&
		existing.mentionId === input.mentionId &&
		existing.targetEntityId === input.targetEntityId &&
		existing.proposedByType === input.proposedBy.type &&
		existing.proposedById === input.proposedBy.id &&
		existing.confidence === input.confidence &&
		existing.rationale === input.rationale
	);
}

async function readExistingProposal(
	db: DbClient,
	organizationId: string,
	clientProposalKey: string,
): Promise<MemoryEntityResolutionDecision | null> {
	const [row] = await db
		.select()
		.from(memoryEntityResolutionDecisions)
		.where(
			and(
				eq(memoryEntityResolutionDecisions.organizationId, organizationId),
				eq(
					memoryEntityResolutionDecisions.clientProposalKey,
					clientProposalKey,
				),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function proposeMemoryEntityResolution(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		clientProposalKey: string;
		mentionId: string;
		targetEntityId: string;
		confidence: number;
		rationale: string;
		evidence?: Record<string, JsonValue>;
		proposedBy: MemoryEntityActor;
		sourceRunId?: string | null;
		proposedAt: string;
	},
): Promise<MemoryEntityResolutionDecision> {
	const { head } = await getMentionAndHead(
		db,
		input.organizationId,
		input.mentionId,
	);
	const target = await requireActiveEntity(
		db,
		input.organizationId,
		input.targetEntityId,
	);
	if (head.currentEntityId === target.id) {
		throw new MemoryEntityGovernanceError(
			"no_state_change",
			"Mention is already resolved to this entity",
		);
	}
	const previous = await getResolutionById(
		db,
		input.organizationId,
		head.currentResolutionId,
	);
	const operation: MemoryEntityResolutionDecision["operation"] =
		head.currentEntityId === null ? "link_mention" : "reassign_mention";
	const inverse: MemoryEntityResolutionInverse = {
		entityId: head.currentEntityId,
		resolutionId: head.currentResolutionId,
		confidence: previous?.confidence ?? null,
	};
	const proposalValues = {
		id: input.id,
		organizationId: input.organizationId,
		clientProposalKey: input.clientProposalKey,
		operation,
		mentionId: input.mentionId,
		sourceEntityId: head.currentEntityId,
		targetEntityId: target.id,
		status: "proposed" as const,
		confidence: input.confidence,
		rationale: input.rationale,
		evidence: input.evidence ?? {},
		proposedByType: input.proposedBy.type,
		proposedById: input.proposedBy.id,
		sourceRunId: input.sourceRunId ?? null,
		expectedMentionVersion: head.version,
		expectedHeadDecisionId: head.lastDecisionId,
		expectedEntityVersion: target.version,
		version: 0,
		inverse,
		proposedAt: input.proposedAt,
	};
	const [created] = await db
		.insert(memoryEntityResolutionDecisions)
		.values(proposalValues)
		.onConflictDoNothing()
		.returning();
	if (created) return created;

	const existing = await readExistingProposal(
		db,
		input.organizationId,
		input.clientProposalKey,
	);
	if (
		existing &&
		sameProposal(existing, {
			id: input.id,
			operation,
			mentionId: input.mentionId,
			targetEntityId: target.id,
			proposedBy: input.proposedBy,
			confidence: input.confidence,
			rationale: input.rationale,
		})
	) {
		return existing;
	}
	throw new MemoryEntityGovernanceError(
		"proposal_conflict",
		"Client proposal key already identifies a different proposal",
	);
}

export async function proposeMemoryEntityResolutionRollback(
	db: DbClient,
	input: {
		id: string;
		organizationId: string;
		clientProposalKey: string;
		rollbackOfDecisionId: string;
		rationale: string;
		evidence?: Record<string, JsonValue>;
		proposedBy: MemoryEntityActor;
		sourceRunId?: string | null;
		proposedAt: string;
	},
): Promise<MemoryEntityResolutionDecision> {
	const [original] = await db
		.select()
		.from(memoryEntityResolutionDecisions)
		.where(
			and(
				eq(
					memoryEntityResolutionDecisions.organizationId,
					input.organizationId,
				),
				eq(memoryEntityResolutionDecisions.id, input.rollbackOfDecisionId),
			),
		)
		.limit(1);
	if (!original) {
		throw new MemoryEntityGovernanceError(
			"proposal_not_found",
			"Decision to roll back was not found",
		);
	}
	if (original.status !== "accepted" || !original.mentionId) {
		throw new MemoryEntityGovernanceError(
			"invalid_operation",
			"Only an accepted mention resolution can be rolled back",
		);
	}
	const { head } = await getMentionAndHead(
		db,
		input.organizationId,
		original.mentionId,
	);
	if (head.lastDecisionId !== original.id) {
		throw new MemoryEntityGovernanceError(
			"state_changed",
			"Only the current accepted resolution can be rolled back",
		);
	}
	const restore = original.inverse as MemoryEntityResolutionInverse;
	const target = restore.entityId
		? await requireActiveEntity(db, input.organizationId, restore.entityId)
		: null;
	const current = await getResolutionById(
		db,
		input.organizationId,
		head.currentResolutionId,
	);
	const inverse: MemoryEntityResolutionInverse = {
		entityId: head.currentEntityId,
		resolutionId: head.currentResolutionId,
		confidence: current?.confidence ?? null,
	};
	const proposalValues = {
		id: input.id,
		organizationId: input.organizationId,
		clientProposalKey: input.clientProposalKey,
		operation: "rollback" as const,
		mentionId: original.mentionId,
		sourceEntityId: head.currentEntityId,
		targetEntityId: target?.id ?? null,
		status: "proposed" as const,
		confidence: restore.confidence ?? original.confidence,
		rationale: input.rationale,
		evidence: input.evidence ?? {},
		proposedByType: input.proposedBy.type,
		proposedById: input.proposedBy.id,
		sourceRunId: input.sourceRunId ?? null,
		expectedMentionVersion: head.version,
		expectedHeadDecisionId: original.id,
		expectedEntityVersion: target?.version ?? null,
		version: 0,
		rollbackOfDecisionId: original.id,
		inverse,
		proposedAt: input.proposedAt,
	};
	const [created] = await db
		.insert(memoryEntityResolutionDecisions)
		.values(proposalValues)
		.onConflictDoNothing()
		.returning();
	if (created) return created;

	const existing = await readExistingProposal(
		db,
		input.organizationId,
		input.clientProposalKey,
	);
	if (
		existing &&
		existing.rollbackOfDecisionId === original.id &&
		sameProposal(existing, {
			id: input.id,
			operation: "rollback",
			mentionId: original.mentionId,
			targetEntityId: target?.id ?? null,
			proposedBy: input.proposedBy,
			confidence: restore.confidence ?? original.confidence,
			rationale: input.rationale,
		})
	) {
		return existing;
	}
	throw new MemoryEntityGovernanceError(
		"proposal_conflict",
		"Rollback has already been proposed with different immutable inputs",
	);
}

export interface ReviewMemoryEntityResolutionResult {
	decision: MemoryEntityResolutionDecision;
	resolution: MemoryEntityResolution | null;
	idempotent: boolean;
}

export async function getMemoryEntityResolutionDecision(
	db: DbClient,
	input: { organizationId: string; decisionId: string },
): Promise<MemoryEntityResolutionDecision | null> {
	const [row] = await db
		.select()
		.from(memoryEntityResolutionDecisions)
		.where(
			and(
				eq(
					memoryEntityResolutionDecisions.organizationId,
					input.organizationId,
				),
				eq(memoryEntityResolutionDecisions.id, input.decisionId),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function reviewMemoryEntityResolutionProposal(
	db: DbClient,
	input: {
		organizationId: string;
		decisionId: string;
		expectedDecisionVersion: number;
		outcome: "accept" | "reject";
		reviewer: MemoryEntityActor;
		reviewRationale: string;
		resolutionId?: string;
		reviewedAt: string;
	},
): Promise<ReviewMemoryEntityResolutionResult> {
	const [decision] = await db
		.select()
		.from(memoryEntityResolutionDecisions)
		.where(
			and(
				eq(
					memoryEntityResolutionDecisions.organizationId,
					input.organizationId,
				),
				eq(memoryEntityResolutionDecisions.id, input.decisionId),
			),
		)
		.limit(1);
	if (!decision) {
		throw new MemoryEntityGovernanceError(
			"proposal_not_found",
			"Resolution proposal was not found",
		);
	}
	if (
		decision.proposedByType === input.reviewer.type &&
		decision.proposedById === input.reviewer.id
	) {
		throw new MemoryEntityGovernanceError(
			"reviewer_not_independent",
			"Proposer cannot review the same entity resolution",
		);
	}
	if (decision.status !== "proposed") {
		const matchingTerminal =
			(input.outcome === "accept" && decision.status === "accepted") ||
			(input.outcome === "reject" && decision.status === "rejected");
		if (!matchingTerminal) {
			throw new MemoryEntityGovernanceError(
				"review_conflict",
				`Proposal is already ${decision.status}`,
			);
		}
		const [resolution] = await db
			.select()
			.from(memoryEntityResolutions)
			.where(eq(memoryEntityResolutions.decisionId, decision.id))
			.limit(1);
		return { decision, resolution: resolution ?? null, idempotent: true };
	}
	if (decision.version !== input.expectedDecisionVersion) {
		throw new MemoryEntityGovernanceError(
			"review_conflict",
			"Proposal version changed before review",
		);
	}

	if (input.outcome === "reject") {
		const [rejected] = await db
			.update(memoryEntityResolutionDecisions)
			.set({
				status: "rejected",
				reviewedByType: input.reviewer.type,
				reviewedById: input.reviewer.id,
				reviewRationale: input.reviewRationale,
				reviewedAt: input.reviewedAt,
				version: sql`${memoryEntityResolutionDecisions.version} + 1`,
			})
			.where(
				and(
					eq(memoryEntityResolutionDecisions.id, decision.id),
					eq(
						memoryEntityResolutionDecisions.organizationId,
						input.organizationId,
					),
					eq(memoryEntityResolutionDecisions.status, "proposed"),
					eq(
						memoryEntityResolutionDecisions.version,
						input.expectedDecisionVersion,
					),
				),
			)
			.returning();
		if (!rejected) {
			throw new MemoryEntityGovernanceError(
				"review_conflict",
				"Proposal was reviewed concurrently",
			);
		}
		return { decision: rejected, resolution: null, idempotent: false };
	}

	if (!input.resolutionId || !decision.mentionId) {
		throw new MemoryEntityGovernanceError(
			"invalid_operation",
			"Acceptance requires a resolution id and mention proposal",
		);
	}
	if (
		!["link_mention", "reassign_mention", "rollback"].includes(
			decision.operation,
		)
	) {
		throw new MemoryEntityGovernanceError(
			"invalid_operation",
			`Operation ${decision.operation} is not implemented by this resolver`,
		);
	}

	const expectedHeadDecisionCondition =
		decision.expectedHeadDecisionId === null
			? isNull(memoryEntityResolutionHeads.lastDecisionId)
			: eq(
					memoryEntityResolutionHeads.lastDecisionId,
					decision.expectedHeadDecisionId,
				);
	const acceptedDecisionExists = exists(
		db
			.select({ one: sql`1` })
			.from(memoryEntityResolutionDecisions)
			.where(
				and(
					eq(memoryEntityResolutionDecisions.id, decision.id),
					eq(memoryEntityResolutionDecisions.status, "accepted"),
					eq(
						memoryEntityResolutionDecisions.reviewedByType,
						input.reviewer.type,
					),
					eq(memoryEntityResolutionDecisions.reviewedById, input.reviewer.id),
				),
			),
	);
	try {
		const coreWrites = [
			db
				.update(memoryEntityResolutionDecisions)
				.set({
					status: "accepted",
					reviewedByType: input.reviewer.type,
					reviewedById: input.reviewer.id,
					reviewRationale: input.reviewRationale,
					reviewedAt: input.reviewedAt,
					appliedAt: input.reviewedAt,
					version: sql`${memoryEntityResolutionDecisions.version} + 1`,
				})
				.where(
					and(
						eq(memoryEntityResolutionDecisions.id, decision.id),
						eq(
							memoryEntityResolutionDecisions.organizationId,
							input.organizationId,
						),
						eq(memoryEntityResolutionDecisions.status, "proposed"),
						eq(
							memoryEntityResolutionDecisions.version,
							input.expectedDecisionVersion,
						),
					),
				)
				.returning({ id: memoryEntityResolutionDecisions.id }),
			db
				.update(memoryEntityResolutionHeads)
				.set({
					version: sql`${memoryEntityResolutionHeads.version} + 1`,
					currentResolutionId: input.resolutionId,
					currentEntityId: decision.targetEntityId,
					lastDecisionId: decision.id,
					updatedAt: input.reviewedAt,
				})
				.where(
					and(
						eq(
							memoryEntityResolutionHeads.organizationId,
							input.organizationId,
						),
						eq(memoryEntityResolutionHeads.mentionId, decision.mentionId),
						eq(
							memoryEntityResolutionHeads.version,
							decision.expectedMentionVersion,
						),
						expectedHeadDecisionCondition,
						acceptedDecisionExists,
					),
				)
				.returning({ mentionId: memoryEntityResolutionHeads.mentionId }),
			db
				.update(memoryEntityResolutions)
				.set({
					status: "revoked",
					validTo: input.reviewedAt,
				})
				.where(
					and(
						eq(memoryEntityResolutions.organizationId, input.organizationId),
						eq(memoryEntityResolutions.mentionId, decision.mentionId),
						eq(memoryEntityResolutions.status, "active"),
					),
				)
				.returning({ id: memoryEntityResolutions.id }),
			db
				.insert(memoryEntityResolutions)
				.values({
					id: input.resolutionId,
					organizationId: input.organizationId,
					mentionId: decision.mentionId,
					entityId: decision.targetEntityId,
					decisionId: decision.id,
					resolutionKind:
						decision.targetEntityId === null ? "unresolved" : "linked",
					status: "active",
					confidence: decision.confidence,
					validFrom: input.reviewedAt,
					validTo: null,
					createdAt: input.reviewedAt,
				})
				.returning(),
		] as const;
		// Migration-owned triggers append projection events in the same D1
		// transaction as these canonical writes. Keeping the outbox at the
		// database boundary also covers callers that bypass this query module.
		const batchResults = await db.batch(coreWrites);
		const resolutions = batchResults[3];
		const resolution = resolutions[0];
		if (!resolution) {
			throw new MemoryEntityGovernanceError(
				"state_changed",
				"Resolution was not materialized",
			);
		}
		const [accepted] = await db
			.select()
			.from(memoryEntityResolutionDecisions)
			.where(eq(memoryEntityResolutionDecisions.id, decision.id))
			.limit(1);
		if (accepted?.status !== "accepted") {
			throw new MemoryEntityGovernanceError(
				"state_changed",
				"Accepted decision was not durably materialized",
			);
		}
		return { decision: accepted, resolution, idempotent: false };
	} catch (error) {
		if (error instanceof MemoryEntityGovernanceError) throw error;
		const [terminal] = await db
			.select()
			.from(memoryEntityResolutionDecisions)
			.where(eq(memoryEntityResolutionDecisions.id, decision.id))
			.limit(1);
		if (terminal?.status === "accepted") {
			const [resolution] = await db
				.select()
				.from(memoryEntityResolutions)
				.where(eq(memoryEntityResolutions.decisionId, decision.id))
				.limit(1);
			if (resolution) {
				return {
					decision: terminal,
					resolution,
					idempotent: true,
				};
			}
		}
		throw new MemoryEntityGovernanceError(
			"state_changed",
			"Resolution head or target entity changed before acceptance",
		);
	}
}

export async function getCurrentMemoryEntityResolution(
	db: DbClient,
	input: { organizationId: string; mentionId: string },
): Promise<MemoryEntityResolution | null> {
	const [row] = await db
		.select()
		.from(memoryEntityResolutions)
		.where(
			and(
				eq(memoryEntityResolutions.organizationId, input.organizationId),
				eq(memoryEntityResolutions.mentionId, input.mentionId),
				eq(memoryEntityResolutions.status, "active"),
			),
		)
		.limit(1);
	return row ?? null;
}

export async function listMemoryEntityResolutionDecisions(
	db: DbClient,
	input: { organizationId: string; mentionId: string; limit?: number },
): Promise<MemoryEntityResolutionDecision[]> {
	return db
		.select()
		.from(memoryEntityResolutionDecisions)
		.where(
			and(
				eq(
					memoryEntityResolutionDecisions.organizationId,
					input.organizationId,
				),
				eq(memoryEntityResolutionDecisions.mentionId, input.mentionId),
			),
		)
		.orderBy(sql`${memoryEntityResolutionDecisions.proposedAt} ASC`)
		.limit(Math.max(1, Math.min(200, Math.trunc(input.limit ?? 100))));
}
