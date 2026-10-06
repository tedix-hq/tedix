import { and, eq, inArray, lt } from "drizzle-orm";
import type { DbClient } from "../../client";
import { knowledgeEntries } from "../../schema/cognitive";

export const TEDI_LEARNED_CAPABILITY_ID_PREFIX = "tcap:";

/** Deterministic knowledge-entry id for a tedi's learned-capability row. */
export function tediLearnedCapabilityEntryId(tediId: string): string {
	return `${TEDI_LEARNED_CAPABILITY_ID_PREFIX}${tediId}`;
}

export interface TediLearnedCapability {
	tediId: string;
	learnedDescription: string;
	evidenceCount: number;
	updatedAt: string;
}

/**
 * Map a learned-capability `knowledge_entries` row to the contract shape.
 * Pure — exported for unit tests. Returns `null` for rows that carry no
 * usable description (empty content) or no tedi linkage, so a malformed row
 * degrades to "no learned capability" rather than junk in the router prompt.
 */
export function knowledgeRowToLearnedCapability(row: {
	tediId: string | null;
	content: string | null;
	sourceCount: number | null;
	updatedAt: string | null;
}): TediLearnedCapability | null {
	if (!row.tediId) return null;
	const description = typeof row.content === "string" ? row.content.trim() : "";
	if (!description) return null;
	return {
		tediId: row.tediId,
		learnedDescription: description,
		evidenceCount: row.sourceCount ?? 0,
		updatedAt: row.updatedAt ?? "",
	};
}

/** D1 caps bound parameters per query (~100) — chunk id lists below it. */
const LEARNED_CAPABILITY_QUERY_CHUNK = 80;

/**
 * Read the learned-capability rows for a set of tedis in one batched pass
 * (chunked `inArray` on the deterministic PK — no per-tedi fan-out), keyed by
 * tediId. Tedis without a distilled row are simply absent from the map.
 */
export async function getTediLearnedCapabilities(
	db: DbClient,
	orgId: string,
	tediIds: string[],
): Promise<Map<string, TediLearnedCapability>> {
	const out = new Map<string, TediLearnedCapability>();
	if (tediIds.length === 0) return out;
	for (let i = 0; i < tediIds.length; i += LEARNED_CAPABILITY_QUERY_CHUNK) {
		const chunk = tediIds.slice(i, i + LEARNED_CAPABILITY_QUERY_CHUNK);
		const rows = await db
			.select({
				tediId: knowledgeEntries.tediId,
				content: knowledgeEntries.content,
				sourceCount: knowledgeEntries.sourceCount,
				updatedAt: knowledgeEntries.updatedAt,
			})
			.from(knowledgeEntries)
			.where(
				and(
					eq(knowledgeEntries.organizationId, orgId),
					inArray(knowledgeEntries.id, chunk.map(tediLearnedCapabilityEntryId)),
				),
			);
		for (const row of rows) {
			const learned = knowledgeRowToLearnedCapability(row);
			if (learned) out.set(learned.tediId, learned);
		}
	}
	return out;
}

export interface UpsertTediLearnedCapabilityInput {
	organizationId: string;
	tediId: string;
	learnedDescription: string;
	evidenceCount: number;
	/** Delegation success rate over the evidence window, [0,1]. */
	successRate: number;
	/** ISO timestamp; defaults to now. */
	updatedAt?: string;
}

/**
 * Upsert a tedi's learned-capability row. Idempotent per (tedi): the
 * deterministic id makes a re-run overwrite the same row (conflict-do-update
 * on PK), never duplicate it.
 */
export async function upsertTediLearnedCapability(
	db: DbClient,
	input: UpsertTediLearnedCapabilityInput,
): Promise<void> {
	const updatedAt = input.updatedAt ?? new Date().toISOString();
	await db
		.insert(knowledgeEntries)
		.values({
			id: tediLearnedCapabilityEntryId(input.tediId),
			organizationId: input.organizationId,
			tediId: input.tediId,
			title: "Evidence-learned capability profile",
			content: input.learnedDescription,
			entryType: "insight",
			sourceCount: input.evidenceCount,
			confidence: input.successRate,
			tags: ["capability-flywheel"],
			updatedAt,
		})
		.onConflictDoUpdate({
			target: knowledgeEntries.id,
			set: {
				content: input.learnedDescription,
				sourceCount: input.evidenceCount,
				confidence: input.successRate,
				updatedAt,
			},
		});
}

/** Drop only a profile older than a newly recorded correction. A subsequent
 * redistillation survives idempotent correction replay. */
export async function invalidateTediLearnedCapabilityBefore(
	db: DbClient,
	input: { organizationId: string; tediId: string; correctionAt: string },
): Promise<void> {
	await db
		.delete(knowledgeEntries)
		.where(
			and(
				eq(knowledgeEntries.organizationId, input.organizationId),
				eq(knowledgeEntries.id, tediLearnedCapabilityEntryId(input.tediId)),
				lt(knowledgeEntries.updatedAt, input.correctionAt),
			),
		);
}
