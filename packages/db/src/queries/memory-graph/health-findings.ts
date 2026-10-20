/**
 * Memory health findings: plain-English, bounded checks over one
 * organization's facts and edges. Every statement is org-scoped, ends in a
 * LIMIT, and is shaped to walk an existing index and stop early, so a large
 * organization cannot turn this read into a table scan (a past outage came
 * from one unbounded memory query).
 *
 * The finding shapes (orphans, stale-but-load-bearing, duplicates) follow the
 * idea of FounderOS `lib/knowledge-metrics.ts` (MIT); the queries are our own.
 */

import { aliasedTable, and, desc, eq, gte, isNull, lt, sql } from "drizzle-orm";
import type { DbClient } from "../../client";
import { memoryEdges, memoryFacts } from "../../schema/memory-graph";

/** Counts stop here; callers show "N+" when `capped`. */
export const FINDING_COUNT_CAP = 500;
export const FINDING_SAMPLE_LIMIT = 5;
/** Orphans are measured over this many most recently updated active facts. */
export const ORPHAN_WINDOW = 2000;
const TEXT_LIMIT = 160;
const DAY_MS = 24 * 60 * 60 * 1000;

export type MemoryFindingKind =
	| "unused"
	| "stale_in_use"
	| "duplicate"
	| "contradiction"
	| "orphan";

export interface MemoryFindingSample {
	factId: string;
	tediId: string | null;
	text: string;
	detail: string;
	confidence: number;
	source: string | null;
	sourceUrl: string | null;
	sourceSessionId: string | null;
	reviewStatus: string | null;
	createdAt: string | null;
	lastVerifiedAt: string | null;
	lastAccessedAt: string | null;
}

export interface MemoryFinding {
	kind: MemoryFindingKind;
	count: number;
	capped: boolean;
	samples: MemoryFindingSample[];
}

export interface MemoryHealthFindingsResult {
	checkedAt: string;
	unusedDays: number;
	staleDays: number;
	orphanWindow: number;
	findings: MemoryFinding[];
}

export interface MemoryHealthFindingsOptions {
	now?: Date;
	unusedDays?: number;
	staleDays?: number;
}

const sampleColumns = {
	factId: memoryFacts.id,
	tediId: memoryFacts.tediId,
	text: sql<string>`substr(${memoryFacts.content}, 1, ${TEXT_LIMIT})`.as(
		"sample_text",
	),
	confidence: memoryFacts.confidence,
	source: memoryFacts.source,
	sourceUrl: memoryFacts.sourceUrl,
	sourceSessionId: memoryFacts.sourceSessionId,
	reviewStatus: memoryFacts.reviewStatus,
	createdAt: memoryFacts.createdAt,
	lastVerifiedAt: memoryFacts.lastVerifiedAt,
	lastAccessedAt: memoryFacts.lastAccessedAt,
};

type SampleRow = Omit<MemoryFindingSample, "detail">;

function toSample(row: SampleRow, detail: string): MemoryFindingSample {
	return {
		factId: row.factId,
		tediId: row.tediId,
		text: row.text,
		detail,
		confidence: row.confidence,
		source: row.source,
		sourceUrl: row.sourceUrl,
		sourceSessionId: row.sourceSessionId,
		reviewStatus: row.reviewStatus,
		createdAt: row.createdAt,
		lastVerifiedAt: row.lastVerifiedAt,
		lastAccessedAt: row.lastAccessedAt,
	};
}

function finish(
	kind: MemoryFindingKind,
	counts: number[],
	samples: MemoryFindingSample[],
): MemoryFinding {
	const total = counts.reduce((sum, n) => sum + n, 0);
	return {
		kind,
		count: Math.min(total, FINDING_COUNT_CAP),
		capped: total > FINDING_COUNT_CAP,
		samples: samples.slice(0, FINDING_SAMPLE_LIMIT),
	};
}

export async function getMemoryHealthFindings(
	db: DbClient,
	orgId: string,
	options: MemoryHealthFindingsOptions = {},
): Promise<MemoryHealthFindingsResult> {
	const now = options.now ?? new Date();
	const unusedDays = options.unusedDays ?? 60;
	const staleDays = options.staleDays ?? 90;
	const iso = (days: number) =>
		new Date(now.getTime() - days * DAY_MS).toISOString();
	const unusedCutoff = iso(unusedDays);
	const staleCutoff = iso(staleDays);
	const recentCutoff = iso(30);
	const capPlusOne = FINDING_COUNT_CAP + 1;

	const active = and(
		eq(memoryFacts.organizationId, orgId),
		isNull(memoryFacts.archivedAt),
	);
	// Seekable on idx_memory_facts_flywheel_accessed (org, last_accessed_at): the
	// NULL and range branches are separate statements because one OR defeats it.
	const neverRetrieved = and(
		active,
		isNull(memoryFacts.lastAccessedAt),
		lt(memoryFacts.createdAt, unusedCutoff),
	);
	const retrievedLongAgo = and(
		active,
		lt(memoryFacts.lastAccessedAt, unusedCutoff),
		lt(memoryFacts.createdAt, unusedCutoff),
	);
	const staleButUsed = and(
		active,
		gte(memoryFacts.lastAccessedAt, recentCutoff),
		lt(
			sql`COALESCE(${memoryFacts.lastVerifiedAt}, ${memoryFacts.updatedAt}, ${memoryFacts.createdAt})`,
			staleCutoff,
		),
	);
	const duplicateGroups = and(
		active,
		isNull(memoryFacts.validTo),
		sql`${memoryFacts.topicKey} IS NOT NULL`,
	);
	const other = aliasedTable(memoryFacts, "contradicted");
	const contradictionJoin = and(
		eq(memoryFacts.organizationId, orgId),
		eq(memoryEdges.relationType, "contradicts"),
		isNull(memoryFacts.archivedAt),
		isNull(other.archivedAt),
	);
	const recentWindow = db
		.select({ windowId: memoryFacts.id })
		.from(memoryFacts)
		.where(active)
		.orderBy(desc(memoryFacts.updatedAt))
		.limit(ORPHAN_WINDOW)
		.as("recent_window");
	const noEdges = and(
		sql`NOT EXISTS (SELECT 1 FROM memory_edges e1 WHERE e1.source_fact_id = ${memoryFacts.id})`,
		sql`NOT EXISTS (SELECT 1 FROM memory_edges e2 WHERE e2.target_fact_id = ${memoryFacts.id})`,
	);

	const cappedFactIds = (name: string, where: ReturnType<typeof and>) =>
		db
			.select({ pick: memoryFacts.id })
			.from(memoryFacts)
			.where(where)
			.limit(capPlusOne)
			.as(name);
	const countFrom = <T extends ReturnType<typeof cappedFactIds>>(sub: T) =>
		db.select({ n: sql<number>`count(*)` }).from(sub);

	const duplicateKeys = db
		.select({ pick: memoryFacts.topicKey })
		.from(memoryFacts)
		.where(duplicateGroups)
		.groupBy(memoryFacts.topicKey)
		.having(sql`count(*) > 1`)
		.limit(capPlusOne)
		.as("dup_keys");
	const contradictionEdges = db
		.select({ pick: memoryEdges.id })
		.from(memoryEdges)
		.innerJoin(memoryFacts, eq(memoryEdges.sourceFactId, memoryFacts.id))
		.innerJoin(other, eq(memoryEdges.targetFactId, other.id))
		.where(contradictionJoin)
		.limit(capPlusOne)
		.as("contradiction_edges");
	const orphanIds = db
		.select({ pick: memoryFacts.id })
		.from(memoryFacts)
		.innerJoin(recentWindow, eq(recentWindow.windowId, memoryFacts.id))
		.where(noEdges)
		.limit(capPlusOne)
		.as("orphan_ids");

	const [
		neverCount,
		neverSamples,
		oldCount,
		oldSamples,
		staleCount,
		staleSamples,
		dupCount,
		dupSamples,
		contraCount,
		contraSamples,
		orphanCount,
		orphanSamples,
	] = await db.batch([
		countFrom(cappedFactIds("never_ids", neverRetrieved)),
		db
			.select(sampleColumns)
			.from(memoryFacts)
			.where(neverRetrieved)
			.limit(FINDING_SAMPLE_LIMIT),
		countFrom(cappedFactIds("old_ids", retrievedLongAgo)),
		db
			.select(sampleColumns)
			.from(memoryFacts)
			.where(retrievedLongAgo)
			.orderBy(memoryFacts.lastAccessedAt)
			.limit(FINDING_SAMPLE_LIMIT),
		countFrom(cappedFactIds("stale_ids", staleButUsed)),
		db
			.select(sampleColumns)
			.from(memoryFacts)
			.where(staleButUsed)
			.orderBy(desc(memoryFacts.lastAccessedAt))
			.limit(FINDING_SAMPLE_LIMIT),
		db.select({ n: sql<number>`count(*)` }).from(duplicateKeys),
		db
			.select({
				...sampleColumns,
				copies: sql<number>`count(*)`.as("copies"),
			})
			.from(memoryFacts)
			.where(duplicateGroups)
			.groupBy(memoryFacts.topicKey)
			.having(sql`count(*) > 1`)
			.limit(FINDING_SAMPLE_LIMIT),
		db.select({ n: sql<number>`count(*)` }).from(contradictionEdges),
		db
			.select({
				...sampleColumns,
				otherText: sql<string>`substr(${other.content}, 1, ${TEXT_LIMIT})`.as(
					"other_text",
				),
			})
			.from(memoryEdges)
			.innerJoin(memoryFacts, eq(memoryEdges.sourceFactId, memoryFacts.id))
			.innerJoin(other, eq(memoryEdges.targetFactId, other.id))
			.where(contradictionJoin)
			.limit(FINDING_SAMPLE_LIMIT),
		db.select({ n: sql<number>`count(*)` }).from(orphanIds),
		db
			.select(sampleColumns)
			.from(memoryFacts)
			.innerJoin(recentWindow, eq(recentWindow.windowId, memoryFacts.id))
			.where(noEdges)
			.limit(FINDING_SAMPLE_LIMIT),
	]);

	const n = (rows: { n: number }[]) => Number(rows[0]?.n ?? 0);

	return {
		checkedAt: now.toISOString(),
		unusedDays,
		staleDays,
		orphanWindow: ORPHAN_WINDOW,
		findings: [
			finish(
				"unused",
				[n(neverCount), n(oldCount)],
				[
					...neverSamples.map((row) =>
						toSample(row, "Never retrieved since it was recorded."),
					),
					...oldSamples.map((row) =>
						toSample(
							row,
							`Last retrieved ${row.lastAccessedAt ?? "long ago"}.`,
						),
					),
				],
			),
			finish(
				"stale_in_use",
				[n(staleCount)],
				staleSamples.map((row) =>
					toSample(
						row,
						"Still retrieved lately but not re-checked in a long time.",
					),
				),
			),
			finish(
				"duplicate",
				[n(dupCount)],
				dupSamples.map((row) =>
					toSample(row, `${row.copies} current facts share one topic key.`),
				),
			),
			finish(
				"contradiction",
				[n(contraCount)],
				contraSamples.map((row) =>
					toSample(row, `Contradicts: "${row.otherText}"`),
				),
			),
			finish(
				"orphan",
				[n(orphanCount)],
				orphanSamples.map((row) =>
					toSample(row, "Not linked to any other fact."),
				),
			),
		],
	};
}
