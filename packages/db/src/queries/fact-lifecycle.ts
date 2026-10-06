/**
 * Fact admission gate + probation TTL (flywheel remodel WS4).
 *
 * Goal: fewer, better-organized memories — consolidation outpaces
 * accumulation. Two mechanisms live here:
 *
 * 1. **Graph-linkage admission gate** (`evaluateFactAdmission`): a candidate
 *    fact must dedupe/link against existing facts/entities to enter at normal
 *    confidence. Linkage signals are cheap and computed at write time —
 *    explicit `relatedTo` edges, a stable topic key (supersession target),
 *    or a same-domain token-overlap match (`countLinkableSameDomainFacts`,
 *    the same heuristic `autoLinkFacts()` uses for `related_to` edges — no
 *    embedding calls on the synchronous write path). Unlinked novel facts
 *    still enter, but always as short-TTL probation with capped confidence.
 *    The write path stamps the decision as `metadata.brainAdmission`; the
 *    deferred vector pass may upgrade `unlinked → linked` when it finds
 *    similar neighbours.
 *
 * 2. **Probation TTL sweep** (`sweepExpiredProbationFacts`): probation facts
 *    never retrieved (access_count = 0) within their TTL auto-archive.
 *    Default TTL is FACT_PROBATION_TTL_DAYS; unlinked facts carry a shorter
 *    per-fact TTL in `metadata.brainAdmission.ttlDays`. Runs fleet-wide from
 *    the daily 3am maintenance cron, batched per org to respect D1 limits.
 *    Archived, not deleted — D1 history is the archive; callers must remove
 *    archived ids from active semantic recall projections.
 */

import { and, eq, isNull, sql } from "drizzle-orm";
import type { DbClient } from "../client";
import { memoryFacts } from "../schema/memory-graph";

/** Days an unretrieved probation fact survives before the TTL sweep archives it. */
export const FACT_PROBATION_TTL_DAYS = 14;
/** Shorter TTL for facts admitted without any graph linkage. */
export const FACT_UNLINKED_PROBATION_TTL_DAYS = 7;
/** Confidence ceiling applied to unlinked facts from gated producers. */
export const FACT_UNLINKED_CONFIDENCE_CEILING = 0.5;
/** Rows read+archived per BATCH per org (each batch is UPDATEd in 50-row chunks). */
export const FACT_TTL_SWEEP_PER_ORG_LIMIT = 200;
/**
 * Drain budget guaranteed per sweep: up to this many bounded batches per org.
 * Admission runs every turn, so a single-batch cap lets the probation backlog
 * grow; several batches (still in 50-row UPDATE chunks) let disposal keep up,
 * while the ceiling keeps each sweep bounded.
 */
export const FACT_TTL_SWEEP_HOMEOSTAT_MAX_BATCHES_PER_ORG = 10;
/** Ids per UPDATE statement (a similar sweep 500'd on 500-row batches). */
const SWEEP_UPDATE_CHUNK = 50;
/** Same-domain candidates inspected by the cheap linkage lookup. */
export const FACT_LINKAGE_CANDIDATE_LIMIT = 40;
/**
 * Token-overlap ratio that counts as a linkage match — mirrors the
 * `related_to` threshold in `autoLinkFacts()` (queries/memory-graph/auto-linking.ts).
 */
export const FACT_LINKAGE_OVERLAP_THRESHOLD = 0.3;

// ============================================================================
// Admission gate
// ============================================================================

export interface FactAdmissionSignals {
	/** Explicit `relatedTo` edges supplied by the caller. */
	relatedFactCount: number;
	/** Current (non-archived, valid) facts sharing the topic key. */
	topicKeyMatches: number;
	/** A stable topic key makes the fact addressable/supersedable. */
	hasTopicKey: boolean;
	/** Cheap same-domain token-overlap matches (see countLinkableSameDomainFacts). */
	similarSameDomainCount: number;
}

export interface FactAdmissionDecision {
	version: 1;
	linkage: "linked" | "unlinked";
	/** Probation TTL the sweep applies to this fact (days, unretrieved). */
	ttlDays: number;
	/** Confidence ceiling to apply at write time; null = no cap. */
	confidenceCeiling: number | null;
	signals: FactAdmissionSignals;
	/** Whether the short-TTL/confidence consequences are enforced (gated producer). */
	enforced: boolean;
	evaluatedAt: string;
}

/**
 * Pure admission decision. `enforced` marks gated producers (afterTurn — the
 * 99.6%-of-inflow producer); non-enforced writers still get the linkage stamp
 * for observability but keep the default TTL and their envelope confidence.
 */
export function evaluateFactAdmission(
	signals: FactAdmissionSignals,
	options?: { enforced?: boolean; now?: string },
): FactAdmissionDecision {
	const enforced = options?.enforced ?? true;
	const linked =
		signals.relatedFactCount > 0 ||
		signals.topicKeyMatches > 0 ||
		signals.hasTopicKey ||
		signals.similarSameDomainCount > 0;
	const unlinkedEnforced = !linked && enforced;
	return {
		version: 1,
		linkage: linked ? "linked" : "unlinked",
		ttlDays: unlinkedEnforced
			? FACT_UNLINKED_PROBATION_TTL_DAYS
			: FACT_PROBATION_TTL_DAYS,
		confidenceCeiling: unlinkedEnforced
			? FACT_UNLINKED_CONFIDENCE_CEILING
			: null,
		signals,
		enforced,
		evaluatedAt: options?.now ?? new Date().toISOString(),
	};
}

function contentTokens(content: string): Set<string> {
	return new Set(
		content
			.toLowerCase()
			.split(/\s+/)
			.filter((word) => word.length > 4),
	);
}

/**
 * Token-overlap ratio between two contents — identical heuristic to the
 * `related_to` detection in `autoLinkFacts()`: share of significant words
 * (>4 chars) in the smaller set that also appear in the other.
 */
export function contentTokenOverlapRatio(a: string, b: string): number {
	const wordsA = contentTokens(a);
	const wordsB = contentTokens(b);
	const minSize = Math.min(wordsA.size, wordsB.size);
	if (minSize === 0) return 0;
	const overlap = [...wordsA].filter((word) => wordsB.has(word)).length;
	return overlap / minSize;
}

/**
 * Cheap write-time linkage lookup: count recent same-domain, non-archived
 * facts whose content token-overlap crosses FACT_LINKAGE_OVERLAP_THRESHOLD.
 * One bounded D1 read (id + content only), overlap computed in JS — no
 * embedding calls on the synchronous write path.
 */
export async function countLinkableSameDomainFacts(
	db: DbClient,
	orgId: string,
	domainId: string,
	content: string,
	options?: { limit?: number },
): Promise<number> {
	const limit = Math.min(
		Math.max(options?.limit ?? FACT_LINKAGE_CANDIDATE_LIMIT, 1),
		200,
	);
	const candidates = await db
		.select({ id: memoryFacts.id, content: memoryFacts.content })
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				eq(memoryFacts.domainId, domainId),
				isNull(memoryFacts.archivedAt),
				isNull(memoryFacts.validTo),
			),
		)
		.orderBy(sql`${memoryFacts.createdAt} DESC`)
		.limit(limit);

	let matches = 0;
	for (const candidate of candidates) {
		if (
			contentTokenOverlapRatio(content, candidate.content) >
			FACT_LINKAGE_OVERLAP_THRESHOLD
		) {
			matches++;
		}
	}
	return matches;
}

// ============================================================================
// Probation TTL sweep
// ============================================================================

export interface SweepExpiredProbationFactsOptions {
	/** Restrict to one org; omit for a fleet-wide sweep. */
	organizationId?: string;
	/** Fallback TTL when a fact carries no `metadata.brainAdmission.ttlDays`. */
	defaultTtlDays?: number;
	/** Rows per BATCH per org (D1 batch safety); default FACT_TTL_SWEEP_PER_ORG_LIMIT. */
	perOrgLimit?: number;
	/**
	 * S5 homeostat protected budget: max bounded batches to drain per org this
	 * sweep (default 1 = legacy single-batch). Effective per-org cap =
	 * maxBatchesPerOrg × perOrgLimit. The scheduled disposal caller passes the
	 * homeostat budget so a large backlog converges instead of starving.
	 */
	maxBatchesPerOrg?: number;
	dryRun?: boolean;
	now?: Date;
}

export interface SweepExpiredProbationFactsResult {
	archived: number;
	archivedIds: string[];
	/** Per-org archive counts for logging. */
	perOrg: Record<string, number>;
	dryRun: boolean;
}

/**
 * Archive probation facts never retrieved (access_count = 0) whose per-fact
 * TTL (`metadata.brainAdmission.ttlDays`, default FACT_PROBATION_TTL_DAYS)
 * has elapsed since creation. Active facts, retrieved facts,
 * already-archived and invalidated facts are never touched. Callers must
 * remove `archivedIds` from active vector recall afterwards.
 */
export async function sweepExpiredProbationFacts(
	db: DbClient,
	options: SweepExpiredProbationFactsOptions = {},
): Promise<SweepExpiredProbationFactsResult> {
	const defaultTtlDays = Math.max(
		options.defaultTtlDays ?? FACT_PROBATION_TTL_DAYS,
		0,
	);
	const perOrgLimit = Math.min(
		Math.max(options.perOrgLimit ?? FACT_TTL_SWEEP_PER_ORG_LIMIT, 1),
		FACT_TTL_SWEEP_PER_ORG_LIMIT,
	);
	// S5 homeostat: bounded batches per org this sweep (default 1 = legacy).
	const maxBatchesPerOrg = Math.min(
		Math.max(options.maxBatchesPerOrg ?? 1, 1),
		FACT_TTL_SWEEP_HOMEOSTAT_MAX_BATCHES_PER_ORG,
	);
	const now = options.now ?? new Date();
	const nowIso = now.toISOString();

	// datetime() normalizes both D1 default "YYYY-MM-DD HH:MM:SS" and ISO
	// timestamps; the per-fact TTL rides in as a '+N days' modifier.
	const expiredCondition = sql`datetime(${memoryFacts.createdAt}, '+' || CAST(COALESCE(json_extract(${memoryFacts.metadata}, '$.brainAdmission.ttlDays'), ${defaultTtlDays}) AS TEXT) || ' days') <= datetime(${nowIso})`;
	const baseConditions = [
		eq(memoryFacts.status, "probation"),
		isNull(memoryFacts.archivedAt),
		isNull(memoryFacts.validTo),
		eq(memoryFacts.accessCount, 0),
		expiredCondition,
	];
	if (options.organizationId) {
		baseConditions.push(eq(memoryFacts.organizationId, options.organizationId));
	}

	// Orgs with eligible facts first, then a bounded id read per org — keeps
	// every statement small instead of one giant fleet-wide UPDATE.
	const orgRows = await db
		.select({ organizationId: memoryFacts.organizationId })
		.from(memoryFacts)
		.where(and(...baseConditions))
		.groupBy(memoryFacts.organizationId);

	const archivedIds: string[] = [];
	const perOrg: Record<string, number> = {};

	for (const { organizationId } of orgRows) {
		// S5 homeostat: drain up to maxBatchesPerOrg bounded batches. Each batch
		// re-reads the oldest eligible ids — because a real archive sets
		// archivedAt, the base conditions (isNull(archivedAt)) exclude already-
		// swept rows, so the next read advances to the NEXT window. A dryRun can't
		// archive, so it previews a single batch only (re-reading would loop).
		let orgArchived = 0;
		for (let batch = 0; batch < maxBatchesPerOrg; batch++) {
			const rows = await db
				.select({ id: memoryFacts.id })
				.from(memoryFacts)
				.where(
					and(
						...baseConditions,
						eq(memoryFacts.organizationId, organizationId),
					),
				)
				.orderBy(sql`${memoryFacts.createdAt} ASC`)
				.limit(perOrgLimit);
			if (rows.length === 0) break;
			const ids = rows.map((row) => row.id);
			archivedIds.push(...ids);
			orgArchived += ids.length;

			if (options.dryRun) break;

			for (let i = 0; i < ids.length; i += SWEEP_UPDATE_CHUNK) {
				const chunk = ids.slice(i, i + SWEEP_UPDATE_CHUNK);
				await db
					.update(memoryFacts)
					.set({
						archivedAt: nowIso,
						updatedAt: nowIso,
						metadata: sql`json_set(COALESCE(${memoryFacts.metadata}, '{}'), '$.archiveReason', 'probation-ttl-sweep')`,
					})
					.where(
						sql`${memoryFacts.id} IN (${sql.join(
							chunk.map((id) => sql`${id}`),
							sql`, `,
						)})`,
					);
			}

			// Fewer than a full batch remained → this org is drained for the cycle.
			if (rows.length < perOrgLimit) break;
		}
		if (orgArchived > 0) perOrg[organizationId] = orgArchived;
	}

	return {
		archived: archivedIds.length,
		archivedIds,
		perOrg,
		dryRun: options.dryRun ?? false,
	};
}
