/**
 * Memory Graph Query Helpers
 * CRUD operations for the knowledge graph — facts, edges, and domains.
 */

import type {
	MemoryFactType,
	MemoryFeedbackSignal,
} from "@tedix/api-contract/constants/enums";
import { and, desc, eq, inArray, isNull, not, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import {
	type FactPriority,
	type FactVisibility,
	type MemoryFact,
	type MemoryReviewStatus,
	type MemoryScope,
	type MemoryUsePolicy,
	memoryFacts,
	type NewMemoryFact,
} from "../../schema/memory-graph";
import { batchNonEmpty } from "../../utils/batch";

export type {
	FactPriority,
	FactVisibility,
	MemoryReviewStatus,
	MemoryScope,
	MemoryUsePolicy,
};
export type FactType = MemoryFactType;

export async function findFactBySourceHash(
	db: DbClient,
	orgId: string,
	sourceHash: string,
): Promise<MemoryFact | undefined> {
	return db.query.memoryFacts.findFirst({
		where: {
			organizationId: orgId,
			sourceHash,
			archivedAt: { isNull: true },
		},
	});
}

export async function findCurrentFactsByTopicKey(
	db: DbClient,
	orgId: string,
	topicKey: string,
	options?: { memoryScope?: MemoryScope },
): Promise<MemoryFact[]> {
	const conditions = [
		eq(memoryFacts.organizationId, orgId),
		eq(memoryFacts.topicKey, topicKey),
		isNull(memoryFacts.archivedAt),
		isNull(memoryFacts.validTo),
	];
	if (options?.memoryScope) {
		conditions.push(eq(memoryFacts.memoryScope, options.memoryScope));
	}
	return db
		.select()
		.from(memoryFacts)
		.where(and(...conditions))
		.orderBy(desc(memoryFacts.createdAt));
}

export async function createFact(
	db: DbClient,
	fact: NewMemoryFact,
): Promise<MemoryFact> {
	const [created] = await db.insert(memoryFacts).values(fact).returning();
	if (!created) throw new Error(`Failed to create fact: ${fact.id}`);
	return created;
}

/**
 * Bulk memory admission gate (agent-capability-mutation-gate ADR).
 *
 * Single-fact learning (`createFact`, the normal loop) is deliberately
 * ungated. Mass admission is a misevolution pathway (memory accumulation
 * degrades safety alignment — Shao et al., ICLR 2026), so any write of more
 * than BULK_FACT_ADMISSION_THRESHOLD facts in one call requires non-agent
 * authority: the handler layer must positively prove a signed-in human or an
 * operator-issued API key (the allowlist doctrine) before setting
 * `operatorAuthority`. No bulk-import endpoint exists today (`createFact` is
 * the only `memory_facts` insert path, every caller single-fact) — this assert gates the query layer any future bulk path must
 * cross, so the door is closed before it is built.
 */
export const BULK_FACT_ADMISSION_THRESHOLD = 20;

export class BulkFactAdmissionError extends Error {
	readonly code = "BULK_FACT_ADMISSION_BLOCKED";
	constructor(readonly factCount: number) {
		super(
			`bulk admission of ${factCount} facts exceeds the agent ceiling of ${BULK_FACT_ADMISSION_THRESHOLD} per call; a signed-in human or an operator-issued API key must authorize mass memory writes (capability-mutation-gate allowlist) — agent callers admit facts through the normal single-fact learning loop`,
		);
		this.name = "BulkFactAdmissionError";
	}
}

export interface BulkFactAdmissionOptions {
	/**
	 * Set ONLY after the handler layer positively proved a human or an
	 * operator-issued API key (see `isLifecycleOverrideAuthority` /
	 * `agentUnreachableCapabilityFieldsTouched` in apps/api). Every other
	 * caller identity — tedi, m2m, service, service-binding, unresolved —
	 * stays capped. Fails closed when omitted.
	 */
	operatorAuthority?: boolean;
}

export function assertBulkFactAdmission(
	factCount: number,
	options?: BulkFactAdmissionOptions,
): void {
	if (factCount <= BULK_FACT_ADMISSION_THRESHOLD) return;
	if (options?.operatorAuthority) return;
	throw new BulkFactAdmissionError(factCount);
}

/**
 * The gated multi-fact insert path. Any future bulk import / batch
 * memory_learn endpoint MUST route through this (not loop `createFact`) so
 * the admission ceiling applies mechanically.
 */
export async function createFacts(
	db: DbClient,
	facts: NewMemoryFact[],
	options?: BulkFactAdmissionOptions,
): Promise<MemoryFact[]> {
	assertBulkFactAdmission(facts.length, options);
	if (facts.length === 0) return [];
	const created: MemoryFact[] = [];
	// Small chunks keep each statement under D1's bound-parameter limit.
	const chunkSize = 5;
	for (let i = 0; i < facts.length; i += chunkSize) {
		const rows = await db
			.insert(memoryFacts)
			.values(facts.slice(i, i + chunkSize))
			.returning();
		created.push(...rows);
	}
	if (created.length !== facts.length) {
		throw new Error(
			`Failed to create facts: expected ${facts.length}, inserted ${created.length}`,
		);
	}
	return created;
}

export async function getFactById(
	db: DbClient,
	factId: string,
): Promise<MemoryFact | undefined> {
	return db.query.memoryFacts.findFirst({ where: { id: factId } });
}

export async function getFactsByIds(
	db: DbClient,
	factIds: string[],
	options?: { includeGraphAnchors?: boolean },
): Promise<MemoryFact[]> {
	if (factIds.length === 0) return [];
	const baseConditions = [
		isNull(memoryFacts.archivedAt),
		isNull(memoryFacts.validTo),
	];
	if (!options?.includeGraphAnchors) {
		baseConditions.push(
			not(eq(memoryFacts.memoryScope, "graph")),
			not(eq(memoryFacts.usePolicy, "do_not_inject_automatically")),
		);
	}
	const CHUNK = 80; // D1 bound-parameter cap headroom (~100)
	const facts: MemoryFact[] = [];
	for (let i = 0; i < factIds.length; i += CHUNK) {
		const batch = factIds.slice(i, i + CHUNK);
		const rows = await db
			.select()
			.from(memoryFacts)
			.where(and(inArray(memoryFacts.id, batch), ...baseConditions));
		facts.push(...rows);
	}
	return facts;
}

export async function updateFact(
	db: DbClient,
	factId: string,
	updates: Partial<NewMemoryFact>,
): Promise<void> {
	await db
		.update(memoryFacts)
		.set({ ...updates, updatedAt: new Date().toISOString() })
		.where(eq(memoryFacts.id, factId));
}

export async function recordFactAccess(
	db: DbClient,
	factId: string,
): Promise<void> {
	await db
		.update(memoryFacts)
		.set({
			lastAccessedAt: new Date().toISOString(),
			accessCount: sql`${memoryFacts.accessCount} + 1`,
		})
		.where(eq(memoryFacts.id, factId));
}

/**
 * Record that a fact has been verified (re-confirmed as still true).
 * Distinct from access — verification means the content was confirmed, not just retrieved.
 */
export async function recordFactVerification(
	db: DbClient,
	factId: string,
	boostFactor: number = 1.1,
): Promise<void> {
	await db
		.update(memoryFacts)
		.set({
			lastVerifiedAt: new Date().toISOString(),
			confidence: sql`MIN(1.0, ${memoryFacts.confidence} * ${boostFactor})`,
			updatedAt: new Date().toISOString(),
		})
		.where(eq(memoryFacts.id, factId));
}

/**
 * Record usage feedback for retrieved facts.
 * Adjusts usageCount and confidence based on signal type.
 */
export async function recordFactUsage(
	db: DbClient,
	factIds: string[],
	signal: MemoryFeedbackSignal,
): Promise<number> {
	if (factIds.length === 0) return 0;

	// "not_used" means retrieved but not used — no DB mutation needed
	if (signal === "not_used") return factIds.length;

	const now = new Date().toISOString();

	const setClause = (() => {
		switch (signal) {
			case "used":
				return {
					usageCount: sql`${memoryFacts.usageCount} + 1`,
					confidence: sql`MIN(1.0, ${memoryFacts.confidence} * 1.02)`,
					updatedAt: now,
				};
			case "outdated":
				return {
					confidence: sql`MAX(0.1, ${memoryFacts.confidence} * 0.9)`,
					updatedAt: now,
				};
			case "wrong":
				return {
					confidence: sql`MAX(0.1, ${memoryFacts.confidence} * 0.85)`,
					updatedAt: now,
				};
			case "failed":
				return {
					confidence: sql`MAX(0.1, ${memoryFacts.confidence} * 0.95)`,
					updatedAt: now,
				};
		}
	})();

	// Batch all updates into a single D1 round-trip
	const queries = factIds.map((factId) =>
		db.update(memoryFacts).set(setClause).where(eq(memoryFacts.id, factId)),
	);
	await db.batch(batchNonEmpty(queries));

	return factIds.length;
}
