/**
 * Memory Graph Query Helpers
 * CRUD operations for the knowledge graph — facts, edges, and domains.
 */

import { type TenantScope, normalizeTenantScope } from "../../tenant-scope";

import {
	refreshConsolidatedForFact,
	filterConsolidatedEvidence,
} from "./observations";

import type {
	MemoryFactType,
	MemoryFeedbackSignal,
} from "@tedix/api-contract/constants/enums";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { coreTable } from "../../core-store/client";
import { anyIds, coreStore } from "../../core-store/dialect";
import { recordOwnerInstructionEdges } from "../decision-graph-writers";
import {
	type FactPriority,
	type FactVisibility,
	type MemoryFact,
	type MemoryReviewStatus,
	type MemoryScope,
	type MemoryUsePolicy,
	memoryFacts as d1MemoryFacts,
	type NewMemoryFact,
} from "../../schema/memory-graph";
import {
	FactChangeBudgetExceeded,
	type FactChangeRecorder,
} from "./memory-adapter";
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
	tenantScope: TenantScope,
	sourceHash: string,
): Promise<MemoryFact | undefined> {
	const memoryFacts = coreTable(db, d1MemoryFacts);
	const { organizationId: orgId } = normalizeTenantScope(tenantScope);
	// Seek the hash through idx_memory_facts_org_source_hash. The unary plus
	// keeps `archived_at` and the ordering away from the live-fact index, which
	// offers both and would walk every live fact of the organization again.
	// The ordering names the fact that walk reached first, so the same one of
	// several facts with one hash is returned as before.
	const [fact] = await db
		.select()
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				eq(memoryFacts.sourceHash, sourceHash),
				coreStore(db) === "d1"
					? sql`+${memoryFacts.archivedAt} IS NULL`
					: isNull(memoryFacts.archivedAt),
			),
		)
		.orderBy(
			coreStore(db) === "d1"
				? sql`+${memoryFacts.validTo}`
				: sql`${memoryFacts.validTo} ASC NULLS FIRST`,
			asc(memoryFacts.confidence),
			sql`${memoryFacts.lastAccessedAt} ASC NULLS FIRST`,
			asc(memoryFacts.createdAt),
			coreStore(db) === "d1" ? sql`${memoryFacts}.rowid` : asc(memoryFacts.id),
		)
		.limit(1);
	return fact;
}

export async function findCurrentFactsByTopicKey(
	db: DbClient,
	tenantScope: TenantScope,
	topicKey: string,
	options?: { memoryScope?: MemoryScope },
): Promise<MemoryFact[]> {
	const memoryFacts = coreTable(db, d1MemoryFacts);
	const { organizationId: orgId } = normalizeTenantScope(tenantScope);
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
	fact: NewMemoryFact & TenantScope,
	recordChange?: FactChangeRecorder,
): Promise<MemoryFact> {
	const memoryFacts = coreTable(db, d1MemoryFacts);
	const scope = normalizeTenantScope(fact);
	fact = { ...fact, ...scope };
	if (
		recordChange?.reserve &&
		(await recordChange.reserve(scope.organizationId, 1)) === 0
	) {
		throw new FactChangeBudgetExceeded(scope.organizationId);
	}
	const [created] = await db.insert(memoryFacts).values(fact).returning();
	if (!created) throw new Error(`Failed to create fact: ${fact.id}`);
	await recordOwnerInstructionEdges(db, created);
	await recordChange?.(created);
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
	tenantScope: TenantScope,
	facts: NewMemoryFact[],
	options?: BulkFactAdmissionOptions,
): Promise<MemoryFact[]> {
	const memoryFacts = coreTable(db, d1MemoryFacts);
	const { organizationId } = normalizeTenantScope(tenantScope);
	assertBulkFactAdmission(facts.length, options);
	if (facts.some((fact) => fact.organizationId !== organizationId)) {
		throw new Error("Memory facts must belong to the tenant scope");
	}
	if (facts.length === 0) return [];
	const created: MemoryFact[] = [];
	// Small chunks keep each statement under D1's bound-parameter limit.
	const chunkSize = coreStore(db) === "postgres" ? facts.length : 5;
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
	for (const fact of created) await recordOwnerInstructionEdges(db, fact);
	return created;
}

export async function getFactById(
	db: DbClient,
	tenantScope: TenantScope,
	factId: string,
): Promise<MemoryFact | undefined> {
	const { organizationId } = normalizeTenantScope(tenantScope);
	return db.query.memoryFacts.findFirst({
		where: { id: factId, organizationId },
	});
}

export async function getFactsByIds(
	db: DbClient,
	tenantScope: TenantScope,
	factIds: string[],
	options?: { includeGraphAnchors?: boolean },
): Promise<MemoryFact[]> {
	const memoryFacts = coreTable(db, d1MemoryFacts);
	const { organizationId } = normalizeTenantScope(tenantScope);
	if (factIds.length === 0) return [];
	// Select by primary key only and filter here: with the archived/valid_to/
	// scope predicates in SQL, D1's planner picked idx_memory_facts_valid_to
	// (nearly every row is valid_to IS NULL) and scanned ~62k rows, ~160 ms per
	// call (2026-10-12).
	const visible = (fact: MemoryFact) =>
		fact.organizationId === organizationId &&
		fact.archivedAt == null &&
		fact.validTo == null &&
		(options?.includeGraphAnchors ||
			(fact.memoryScope !== "graph" &&
				fact.usePolicy !== "do_not_inject_automatically"));
	const rows = await db
		.select()
		.from(memoryFacts)
		.where(anyIds(db, memoryFacts.id, factIds));
	const facts = rows.filter(visible);
	if (options?.includeGraphAnchors) return facts;
	return filterConsolidatedEvidence(db, tenantScope, facts, false);
}

export async function updateFact(
	db: DbClient,
	tenantScope: TenantScope,
	factId: string,
	updates: Partial<NewMemoryFact>,
	recordChange?: FactChangeRecorder,
): Promise<boolean> {
	const memoryFacts = coreTable(db, d1MemoryFacts);
	const { organizationId } = normalizeTenantScope(tenantScope);
	if (
		updates.organizationId !== undefined &&
		updates.organizationId !== organizationId
	) {
		throw new Error("Memory fact organization cannot change");
	}
	if (
		recordChange?.reserve &&
		(await recordChange.reserve(organizationId, 1)) === 0
	) {
		return false;
	}
	const mutation = db
		.update(memoryFacts)
		.set({ ...updates, updatedAt: new Date().toISOString() })
		.where(
			and(
				eq(memoryFacts.organizationId, organizationId),
				eq(memoryFacts.id, factId),
			),
		);
	const changed = recordChange
		? await mutation.returning()
		: (await mutation, []);
	if (
		updates.content !== undefined ||
		updates.validTo !== undefined ||
		updates.archivedAt !== undefined ||
		updates.reviewStatus !== undefined ||
		updates.metadata !== undefined ||
		updates.visibility !== undefined ||
		updates.tediId !== undefined ||
		updates.memoryScope !== undefined ||
		updates.topicKey !== undefined ||
		updates.status !== undefined
	) {
		const fact = await getFactById(db, tenantScope, factId);
		if (fact) {
			await recordOwnerInstructionEdges(db, fact);
			await refreshConsolidatedForFact(db, tenantScope, factId);
		}
	}
	for (const fact of changed) await recordChange?.(fact);
	return recordChange ? changed.length > 0 : true;
}

export async function recordFactAccess(
	db: DbClient,
	tenantScope: TenantScope,
	factId: string,
): Promise<void> {
	const memoryFacts = coreTable(db, d1MemoryFacts);
	const { organizationId } = normalizeTenantScope(tenantScope);
	await db
		.update(memoryFacts)
		.set({
			lastAccessedAt: new Date().toISOString(),
			accessCount: sql`${memoryFacts.accessCount} + 1`,
		})
		.where(
			and(
				eq(memoryFacts.organizationId, organizationId),
				eq(memoryFacts.id, factId),
			),
		);
}

/**
 * Record that a fact has been verified (re-confirmed as still true).
 * Distinct from access — verification means the content was confirmed, not just retrieved.
 */
export async function recordFactVerification(
	db: DbClient,
	tenantScope: TenantScope,
	factId: string,
	boostFactor: number = 1.1,
): Promise<void> {
	const memoryFacts = coreTable(db, d1MemoryFacts);
	const { organizationId } = normalizeTenantScope(tenantScope);
	await db
		.update(memoryFacts)
		.set({
			lastVerifiedAt: new Date().toISOString(),
			confidence: sql`${coreStore(db) === "postgres" ? sql`LEAST` : sql`MIN`}(1.0, ${memoryFacts.confidence} * ${boostFactor})`,
			updatedAt: new Date().toISOString(),
		})
		.where(
			and(
				eq(memoryFacts.organizationId, organizationId),
				eq(memoryFacts.id, factId),
			),
		);
}

/**
 * Record usage feedback for retrieved facts.
 * Adjusts usageCount and confidence based on signal type.
 */
export async function recordFactUsage(
	db: DbClient,
	tenantScope: TenantScope,
	factIds: string[],
	signal: MemoryFeedbackSignal,
): Promise<number> {
	const memoryFacts = coreTable(db, d1MemoryFacts);
	const { organizationId } = normalizeTenantScope(tenantScope);
	if (factIds.length === 0) return 0;

	// "not_used" means retrieved but not used — no DB mutation needed
	if (signal === "not_used") return factIds.length;

	const now = new Date().toISOString();
	// Repeated IDs retain the former batch's repeated reinforcement/penalty.
	const counts = new Map<string, number>();
	for (const id of factIds) counts.set(id, (counts.get(id) ?? 0) + 1);
	const groups = new Map<number, string[]>();
	for (const [id, count] of counts) {
		const ids = groups.get(count) ?? [];
		ids.push(id);
		groups.set(count, ids);
	}
	const factor = { used: 1.02, outdated: 0.9, wrong: 0.85, failed: 0.95 }[
		signal
	];
	const clamp =
		coreStore(db) === "postgres"
			? signal === "used"
				? sql`LEAST`
				: sql`GREATEST`
			: signal === "used"
				? sql`MIN`
				: sql`MAX`;
	const queries = [...groups].map(([count, ids]) =>
		db
			.update(memoryFacts)
			.set({
				usageCount:
					signal === "used"
						? sql`${memoryFacts.usageCount} + ${count}`
						: undefined,
				confidence: sql`${clamp}(${signal === "used" ? 1.0 : 0.1}, ${memoryFacts.confidence} * ${factor ** count})`,
				updatedAt: now,
			})
			.where(
				and(
					eq(memoryFacts.organizationId, organizationId),
					anyIds(db, memoryFacts.id, ids),
				),
			),
	);
	await db.batch(batchNonEmpty(queries));
	return factIds.length;
}
