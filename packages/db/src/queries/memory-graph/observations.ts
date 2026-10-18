import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
	MemoryConsolidationSchema,
	type MemoryConsolidation,
} from "@tedix/api-contract/schemas/memory-observations";
import { prefixedColumns } from "../../utils/select";
import type { DbQueryClient } from "../../query-client";
import {
	memoryFacts,
	type MemoryFact,
	type NewMemoryFact,
} from "../../schema/memory-graph";

const MAX_SOURCES = 50;
const MAX_TARGETS = 10;
// Lifecycle indexes can make D1 scan the active corpus even for two source IDs.
const factsById = sql`${memoryFacts} INDEXED BY sqlite_autoindex_memory_facts_1`;
const derivedFacts = sql`${memoryFacts} INDEXED BY idx_memory_facts_source`;
const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
export function readConsolidation(fact: { metadata: MemoryFact["metadata"] }) {
	const result = MemoryConsolidationSchema.safeParse(
		fact.metadata?.consolidation,
	);
	return result.success ? result.data : null;
}
interface Target {
	entityKey: string;
	topicKey: string | null;
	tediId: string | null;
	visibility: MemoryFact["visibility"];
	memoryScope: MemoryFact["memoryScope"];
}
const observationTopic = sql<
	string | null
>`CASE WHEN json_type(${memoryFacts.metadata}, '$.observationTopic') = 'text'
	THEN nullif(trim(json_extract(${memoryFacts.metadata}, '$.observationTopic')), '') ELSE NULL END`;
const entityKey = sql<string>`coalesce((SELECT 'entity:' || r.entity_id
	FROM memory_entity_resolutions r JOIN memory_entity_mentions m ON m.id = r.mention_id AND m.organization_id = memory_facts.organization_id
	JOIN memory_entities e ON e.id = r.entity_id AND e.organization_id = memory_facts.organization_id AND e.status = 'active'
	WHERE r.organization_id = memory_facts.organization_id AND r.status = 'active' AND r.valid_to IS NULL
	AND m.source_fact_id = memory_facts.id ORDER BY r.entity_id LIMIT 1), ${observationTopic}, memory_facts.topic_key)`;
// Source topic keys are state/supersession identities. An explicit observation
// topic groups independent sources without making them supersede one another.
const clusterTopic = sql<string | null>`CASE WHEN ${entityKey} LIKE 'entity:%'
	THEN ${observationTopic}
	ELSE coalesce(${observationTopic}, ${memoryFacts.topicKey}) END`;
function sourceTopic(topicKey: string | null | undefined) {
	return topicKey
		? sql`(${memoryFacts.topicKey} = ${topicKey} OR ${observationTopic} = ${topicKey})`
		: undefined;
}
function scope(orgId: string, target: Target) {
	return and(
		eq(memoryFacts.organizationId, orgId),
		target.tediId
			? eq(memoryFacts.tediId, target.tediId)
			: isNull(memoryFacts.tediId),
		sql`${memoryFacts.visibility} IS ${target.visibility}`,
		sql`${memoryFacts.memoryScope} IS ${target.memoryScope}`,
	);
}
function rawSources(orgId: string) {
	return and(
		eq(memoryFacts.organizationId, orgId),
		isNull(memoryFacts.validTo),
		isNull(memoryFacts.archivedAt),
		eq(memoryFacts.status, "active"),
		sql`coalesce(${memoryFacts.reviewStatus}, '') NOT IN ('rejected', 'restricted', 'stale', 'superseded')`,
		sql`coalesce(${memoryFacts.usePolicy}, '') != 'do_not_inject_automatically'`,
		sql`coalesce(${memoryFacts.memoryScope}, '') != 'graph'`,
		sql`json_extract(${memoryFacts.metadata}, '$.consolidation') IS NULL`,
		// Personal decision rules retain their own evidence and owner boundary.
		sql`json_extract(${memoryFacts.metadata}, '$.learningFeed') IS NULL`,
		sql`(${memoryFacts.validFrom} IS NULL OR datetime(${memoryFacts.validFrom}) <= datetime('now'))`,
		sql`(json_extract(${memoryFacts.metadata}, '$.expiresAt') IS NULL OR datetime(json_extract(${memoryFacts.metadata}, '$.expiresAt')) > datetime('now'))`,
		sql`NOT EXISTS (SELECT 1 FROM memory_edges edge JOIN memory_facts replacement ON replacement.id = edge.source_fact_id
		WHERE edge.target_fact_id = ${memoryFacts.id} AND edge.relation_type = 'supersedes'
		AND replacement.organization_id = ${orgId})`,
	);
}
async function digest(value: unknown): Promise<string> {
	const hash = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(JSON.stringify(value)),
	);
	return Array.from(new Uint8Array(hash), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}
async function headId(
	orgId: string,
	target: Target,
	kind: MemoryConsolidation["kind"],
) {
	return `memory-${kind}:${await digest([orgId, target.entityKey, kind === "observation" ? target.topicKey : null, target.tediId, target.visibility, target.memoryScope])}`;
}
async function readHead(db: DbQueryClient, orgId: string, id: string) {
	const [row] = await db
		.select()
		.from(memoryFacts)
		.where(and(eq(memoryFacts.organizationId, orgId), eq(memoryFacts.id, id)));
	return row;
}
/** Exact-source refreshes are extractive: removing evidence cannot preserve its old claim. */
function statement(sources: MemoryFact[], disputed: boolean): string {
	const texts = [
		...new Set(sources.map((source) => normalize(source.content))),
	];
	return `${disputed ? "Conflicting evidence: " : ""}${texts.join(" ")}`;
}
async function persist(
	db: DbQueryClient,
	orgId: string,
	target: Target,
	kind: MemoryConsolidation["kind"],
	sources: MemoryFact[],
	options: {
		disputed?: boolean;
		observationIds?: string[];
		changedSourceIds?: string[];
	} = {},
): Promise<MemoryFact | undefined> {
	const id = await headId(orgId, target, kind);
	const old = await readHead(db, orgId, id);
	const previous = old && readConsolidation(old);
	if (!old && !sources.length) return undefined;
	if (old?.archivedAt || old?.validTo) return old;
	const state = !sources.length
		? "retracted"
		: options.disputed
			? "disputed"
			: "live";
	const text = sources.length
		? statement(sources, !!options.disputed)
		: "No supported claims remain.";
	const citations = sources.map((fact) => ({
		kind: "fact" as const,
		id: fact.id,
		quote: normalize(fact.content).slice(0, 280),
	}));
	const fingerprint = await digest([
		state,
		text,
		sources.map((fact) => [fact.id, fact.content, fact.confidence]),
		options.observationIds ?? [],
	]);
	if (previous?.fingerprint === fingerprint && previous.state === state)
		return old;
	const now = new Date().toISOString();
	const removed =
		previous?.evidence.sources
			.map((s) => s.id)
			.filter((id) => !sources.some((s) => s.id === id)) ?? [];
	const seen = sources
		.flatMap((fact) => fact.validFrom ?? fact.createdAt ?? [])
		.sort();
	const revision = (previous?.revision ?? 0) + 1;
	const historyId = old ? `${id}:v${previous?.revision ?? 1}` : null;
	const consolidation: MemoryConsolidation = {
		version: 1,
		kind,
		entityKey: target.entityKey,
		topicKey: target.topicKey,
		revision,
		fingerprint,
		state,
		evidence: {
			version: 1,
			sources: citations,
			supportCount: citations.length,
			state: state === "live" ? "live" : "held",
		},
		sourceHashes: Object.fromEntries(
			await Promise.all(
				sources.map(async (source) => [
					source.id,
					await digest(source.content),
				]),
			),
		),
		scope: {
			tediId: target.tediId,
			visibility: target.visibility,
			memoryScope: target.memoryScope,
		},
		observationIds: options.observationIds ?? [],
		firstSeen: seen[0] ?? previous?.firstSeen ?? null,
		lastSeen: seen.at(-1) ?? previous?.lastSeen ?? null,
		previousVersionId: historyId,
		isHistory: false,
		refresh: {
			at: now,
			reason: removed.length
				? "source_invalidated"
				: options.disputed
					? "contradiction"
					: old
						? "source_changed"
						: "new_evidence",
			sourceFactIds: [
				...new Set([
					...(options.changedSourceIds ?? []),
					...citations.map((s) => s.id),
					...removed,
				]),
			],
			removedSourceFactIds: removed,
			previousText: old?.content ?? null,
		},
	};
	const values: NewMemoryFact = {
		id,
		organizationId: orgId,
		tediId: target.tediId,
		visibility: target.visibility,
		memoryScope: target.memoryScope,
		domainId: sources[0]?.domainId ?? old?.domainId,
		topicKey: `${kind}:${target.entityKey}:${target.topicKey ?? ""}`,
		content: text,
		summary: text,
		factType: "pattern",
		status: "active",
		confidence: sources.length
			? sources.reduce((sum, fact) => sum + fact.confidence, 0) / sources.length
			: 0,
		source: `consolidation://${kind}`,
		usePolicy:
			state === "live" ? "can_use_as_evidence" : "do_not_inject_automatically",
		reviewStatus:
			state === "disputed"
				? "disputed"
				: state === "live"
					? "evidence_only"
					: "stale",
		metadata: { consolidation },
		validTo: null,
		archivedAt: null,
		updatedAt: now,
	};
	if (old) {
		// The immutable previous version and CAS head update share one D1 batch.
		// A concurrent refresh may add the same snapshot, but cannot overwrite a newer head.
		await db.batch([
			db
				.insert(memoryFacts)
				.values({
					...old,
					id: historyId!,
					validTo: now,
					archivedAt: now,
					usePolicy: "do_not_inject_automatically",
					metadata: {
						...old.metadata,
						consolidation: { ...previous!, isHistory: true },
					},
				})
				.onConflictDoNothing(),
			db
				.update(memoryFacts)
				.set(values)
				.where(
					and(
						eq(memoryFacts.organizationId, orgId),
						eq(memoryFacts.id, id),
						sql`${memoryFacts.metadata} IS ${JSON.stringify(old.metadata)}`,
					),
				),
		]);
	} else await db.insert(memoryFacts).values(values).onConflictDoNothing();
	return readHead(db, orgId, id);
}
async function refreshTarget(
	db: DbQueryClient,
	orgId: string,
	target: Target,
	changedSourceIds: string[] = [],
) {
	let sources = await db
		.select()
		.from(memoryFacts)
		.where(
			and(
				scope(orgId, target),
				sourceTopic(target.topicKey),
				rawSources(orgId),
				sql`${entityKey} = ${target.entityKey}`,
				sql`${clusterTopic} IS ${target.topicKey}`,
			),
		)
		.orderBy(asc(memoryFacts.id))
		.limit(MAX_SOURCES + 1);
	const clusterIds = sources.map((source) => source.id);
	if (clusterIds.length && clusterIds.length <= MAX_SOURCES) {
		// Explicit conflicts are evidence for this observation even when the
		// new source has a different state/topic key. Keep the same read scope.
		const opposing = await db
			.select(prefixedColumns(memoryFacts, "fact"))
			.from(factsById)
			.where(
				and(
					rawSources(orgId),
					scope(orgId, target),
					sql`${memoryFacts.id} IN (
			SELECT edge.target_fact_id FROM memory_edges edge WHERE edge.relation_type = 'contradicts' AND edge.source_fact_id IN (SELECT value FROM json_each(${JSON.stringify(clusterIds)}))
			UNION SELECT edge.source_fact_id FROM memory_edges edge WHERE edge.relation_type = 'contradicts' AND edge.target_fact_id IN (SELECT value FROM json_each(${JSON.stringify(clusterIds)})))`,
				),
			)
			.orderBy(asc(memoryFacts.id))
			.limit(MAX_SOURCES + 1);
		sources = [
			...new Map(
				[...sources, ...opposing].map((source) => [source.id, source]),
			).values(),
		].sort((a, b) => a.id.localeCompare(b.id));
	}
	// Never turn a bounded sample into a complete summary of a larger cluster.
	if (sources.length > MAX_SOURCES) return { written: 0, overflow: true };
	if (
		sources.length < 2 &&
		!(await readHead(db, orgId, await headId(orgId, target, "observation")))
	)
		return { written: 0, overflow: false };
	const ids = sources.map((fact) => fact.id);
	const conflicts = ids.length
		? await db
				.select({ id: sql<string>`edge.id` })
				.from(sql`memory_edges edge`)
				.where(
					sql`edge.relation_type = 'contradicts' AND edge.source_fact_id IN (SELECT value FROM json_each(${JSON.stringify(ids)})) AND edge.target_fact_id IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
				)
				.limit(1)
		: [];
	const observation = await persist(db, orgId, target, "observation", sources, {
		disputed:
			conflicts.length > 0 ||
			sources.some((s) => s.reviewStatus === "disputed"),
		changedSourceIds,
	});
	if (!observation) return { written: 0, overflow: false };
	await refreshSummary(db, orgId, target, changedSourceIds);
	await db
		.update(memoryFacts)
		.set({ lastVerifiedAt: new Date().toISOString() })
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				eq(memoryFacts.id, observation.id),
			),
		);
	return { written: 1, overflow: false };
}
async function refreshSummary(
	db: DbQueryClient,
	orgId: string,
	target: Target,
	changedSourceIds: string[],
) {
	const observations = await db
		.select(prefixedColumns(memoryFacts, "fact"))
		.from(derivedFacts)
		.where(
			and(
				scope(orgId, target),
				eq(memoryFacts.source, "consolidation://observation"),
				sql`json_extract(${memoryFacts.metadata}, '$.consolidation.kind') = 'observation'`,
				sql`json_extract(${memoryFacts.metadata}, '$.consolidation.isHistory') = 0`,
				sql`json_extract(${memoryFacts.metadata}, '$.consolidation.entityKey') = ${target.entityKey}`,
			),
		)
		.orderBy(asc(memoryFacts.id))
		.limit(MAX_SOURCES + 1);
	if (observations.length > MAX_SOURCES) return;
	const live = await filterConsolidatedEvidence(db, orgId, observations, false);
	// Summary citations remain raw facts, so a source retraction invalidates both levels.
	const sourceIds = [
		...new Set(
			live.flatMap(
				(observation) =>
					readConsolidation(observation)?.evidence.sources.map(
						(source) => source.id,
					) ?? [],
			),
		),
	];
	if (sourceIds.length > MAX_SOURCES) return;
	const sources = sourceIds.length
		? await db
				.select(prefixedColumns(memoryFacts, "fact"))
				.from(factsById)
				.where(and(rawSources(orgId), inArray(memoryFacts.id, sourceIds)))
				.orderBy(asc(memoryFacts.id))
		: [];
	await persist(
		db,
		orgId,
		{ ...target, topicKey: null },
		"standing_summary",
		sources,
		{
			observationIds: live.map((observation) => observation.id),
			changedSourceIds,
		},
	);
}

/** Rotate existing heads by last evidence check and admit new topics in bounded groups. */
export async function consolidateMemory(
	db: DbQueryClient,
	orgId: string,
	options: { tediId?: string; topicKey?: string; limit?: number } = {},
) {
	const limit = Math.min(
		MAX_TARGETS,
		Math.max(1, options.limit ?? MAX_TARGETS),
	);
	const heads = await db
		.select(prefixedColumns(memoryFacts, "fact"))
		.from(derivedFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				eq(memoryFacts.source, "consolidation://observation"),
				options.tediId ? eq(memoryFacts.tediId, options.tediId) : undefined,
				sql`json_extract(${memoryFacts.metadata}, '$.consolidation.kind') = 'observation'`,
				sql`json_extract(${memoryFacts.metadata}, '$.consolidation.isHistory') = 0`,
				options.topicKey
					? sql`json_extract(${memoryFacts.metadata}, '$.consolidation.topicKey') = ${options.topicKey}`
					: undefined,
			),
		)
		.orderBy(asc(memoryFacts.lastVerifiedAt), asc(memoryFacts.id))
		.limit(limit);
	const recent = await db
		.select({
			entityKey,
			topicKey: clusterTopic,
			tediId: memoryFacts.tediId,
			visibility: memoryFacts.visibility,
			memoryScope: memoryFacts.memoryScope,
		})
		.from(memoryFacts)
		.where(
			and(
				sourceTopic(options.topicKey),
				rawSources(orgId),
				options.tediId ? eq(memoryFacts.tediId, options.tediId) : undefined,
				options.topicKey
					? sql`${clusterTopic} IS ${options.topicKey}`
					: undefined,
				sql`${entityKey} IS NOT NULL`,
				sql`NOT EXISTS (SELECT 1 FROM memory_facts head WHERE head.organization_id = ${orgId}
				AND head.source = 'consolidation://observation' AND head.valid_to IS NULL AND head.archived_at IS NULL
				AND json_extract(head.metadata, '$.consolidation.entityKey') = ${entityKey}
				AND json_extract(head.metadata, '$.consolidation.topicKey') IS ${clusterTopic}
				AND head.tedi_id IS memory_facts.tedi_id AND head.visibility IS memory_facts.visibility AND head.memory_scope IS memory_facts.memory_scope)`,
			),
		)
		.groupBy(
			entityKey,
			clusterTopic,
			memoryFacts.tediId,
			memoryFacts.visibility,
			memoryFacts.memoryScope,
		)
		.having(sql`count(*) >= 2`)
		.orderBy(desc(sql`max(${memoryFacts.updatedAt})`))
		.limit(limit);
	const targets = new Map<string, Target>();
	for (const head of heads) {
		const meta = readConsolidation(head);
		if (meta) {
			const target = {
				...head,
				entityKey: meta.entityKey,
				topicKey: meta.topicKey,
			};
			targets.set(
				JSON.stringify([
					target.entityKey,
					target.topicKey,
					target.tediId,
					target.visibility,
					target.memoryScope,
				]),
				target,
			);
		}
	}
	for (const target of recent)
		targets.set(
			JSON.stringify([
				target.entityKey,
				target.topicKey,
				target.tediId,
				target.visibility,
				target.memoryScope,
			]),
			target,
		);
	let observations = 0,
		overflow = 0;
	for (const target of [...targets.values()].slice(0, MAX_TARGETS * 2)) {
		const result = await refreshTarget(db, orgId, target);
		observations += result.written;
		overflow += Number(result.overflow);
	}
	return { observations, overflow };
}

/** Mutation path: every direct dependent is refreshed, in bounded pages, without a model call. */
export async function refreshConsolidatedForFact(
	db: DbQueryClient,
	orgId: string,
	factId: string,
) {
	let cursor = "";
	while (true) {
		const rows = await db
			.select(prefixedColumns(memoryFacts, "fact"))
			.from(derivedFacts)
			.where(
				and(
					eq(memoryFacts.organizationId, orgId),
					eq(memoryFacts.source, "consolidation://observation"),
					sql`${memoryFacts.id} > ${cursor}`,
					sql`json_extract(${memoryFacts.metadata}, '$.consolidation.kind') = 'observation'`,
					sql`json_extract(${memoryFacts.metadata}, '$.consolidation.isHistory') = 0`,
					sql`EXISTS (SELECT 1 FROM json_each(json_extract(${memoryFacts.metadata}, '$.consolidation.evidence.sources')) citation WHERE json_extract(citation.value, '$.id') = ${factId})`,
				),
			)
			.orderBy(asc(memoryFacts.id))
			.limit(10);
		for (const row of rows) {
			const meta = readConsolidation(row);
			if (meta)
				await refreshTarget(
					db,
					orgId,
					{ ...row, entityKey: meta.entityKey, topicKey: meta.topicKey },
					[factId],
				);
		}
		if (rows.length < 10) break;
		cursor = rows.at(-1)!.id;
	}
}

/** Shared recall boundary: held evidence is never injected, even before the next reflection. */
export async function filterConsolidatedEvidence<
	T extends { id: string; metadata: MemoryFact["metadata"] },
>(db: DbQueryClient, orgId: string, rows: T[], prefer = true): Promise<T[]> {
	const derived = rows.filter(
		(row) => row.metadata?.consolidation !== undefined,
	);
	if (!derived.length) return rows;
	const sourceIds = [
		...new Set(
			derived.flatMap(
				(row) =>
					readConsolidation(row)?.evidence.sources.map((s) => s.id) ?? [],
			),
		),
	];
	const sources: MemoryFact[] = [];
	for (let i = 0; i < sourceIds.length; i += 50)
		sources.push(
			...(await db
				.select(prefixedColumns(memoryFacts, "fact"))
				.from(factsById)
				.where(
					and(
						rawSources(orgId),
						inArray(memoryFacts.id, sourceIds.slice(i, i + 50)),
					),
				)),
		);
	const live = new Map(sources.map((source) => [source.id, source]));
	const hashes = new Map(
		await Promise.all(
			sources.map(
				async (source) => [source.id, await digest(source.content)] as const,
			),
		),
	);
	const observationIds = [
		...new Set(
			derived.flatMap((row) => readConsolidation(row)?.observationIds ?? []),
		),
	];
	const liveObservations = new Set<string>();
	for (let i = 0; i < observationIds.length; i += 50) {
		const heads = await db
			.select(prefixedColumns(memoryFacts, "fact"))
			.from(factsById)
			.where(
				and(
					eq(memoryFacts.organizationId, orgId),
					inArray(memoryFacts.id, observationIds.slice(i, i + 50)),
					isNull(memoryFacts.validTo),
					isNull(memoryFacts.archivedAt),
					sql`json_extract(${memoryFacts.metadata}, '$.consolidation.state') = 'live'`,
					sql`json_extract(${memoryFacts.metadata}, '$.consolidation.isHistory') = 0`,
				),
			);
		for (const head of heads) liveObservations.add(head.id);
	}
	// A newly written conflict must hold cached claims even before its refresh finishes.
	const conflicted = new Set<string>();
	for (let i = 0; i < sourceIds.length; i += 50) {
		const ids = sourceIds.slice(i, i + 50);
		const conflicts = await db
			.select({ id: sql<string>`f.id` })
			.from(sql`memory_facts f INDEXED BY sqlite_autoindex_memory_facts_1`)
			.where(sql`f.organization_id = ${orgId} AND f.id IN (SELECT value FROM json_each(${JSON.stringify(ids)})) AND EXISTS (
			SELECT 1 FROM memory_edges edge JOIN memory_facts other ON other.id = CASE WHEN edge.source_fact_id = f.id THEN edge.target_fact_id ELSE edge.source_fact_id END
			WHERE edge.relation_type = 'contradicts' AND (edge.source_fact_id = f.id OR edge.target_fact_id = f.id)
			AND other.organization_id = ${orgId} AND other.valid_to IS NULL AND other.archived_at IS NULL)`);
		for (const conflict of conflicts) conflicted.add(conflict.id);
	}
	const eligible = rows.filter((row) => {
		if (row.metadata?.consolidation === undefined) return true;
		const meta = readConsolidation(row);
		return (
			!!meta &&
			!("validTo" in row && row.validTo) &&
			!("archivedAt" in row && row.archivedAt) &&
			!meta.isHistory &&
			meta.state === "live" &&
			"content" in row &&
			row.content ===
				statement(
					meta.evidence.sources.flatMap(
						(citation) => live.get(citation.id) ?? [],
					),
					false,
				) &&
			(meta.kind === "observation"
				? meta.observationIds.length === 0
				: meta.observationIds.length > 0) &&
			meta.evidence.state === "live" &&
			meta.evidence.sources.length > 0 &&
			meta.evidence.supportCount ===
				new Set(meta.evidence.sources.map((s) => s.id)).size &&
			meta.observationIds.every((id) => liveObservations.has(id)) &&
			meta.evidence.sources.every((citation) => {
				const source = live.get(citation.id);
				return (
					source &&
					source.reviewStatus !== "disputed" &&
					!conflicted.has(source.id) &&
					source.tediId === meta.scope.tediId &&
					source.visibility === meta.scope.visibility &&
					source.memoryScope === meta.scope.memoryScope &&
					hashes.get(source.id) === meta.sourceHashes[source.id] &&
					normalize(source.content).includes(citation.quote)
				);
			})
		);
	});
	if (!prefer) return eligible;
	const covered = new Set(
		eligible.flatMap((row) => {
			const meta = readConsolidation(row);
			return meta
				? [...meta.evidence.sources.map((s) => s.id), ...meta.observationIds]
				: [];
		}),
	);
	return eligible.filter((row) => !covered.has(row.id));
}

export async function listMemoryObservations(
	db: DbQueryClient,
	orgId: string,
	options: {
		topicKey?: string;
		tediId?: string;
		limit?: number;
		includeHistory?: boolean;
	} = {},
) {
	return db
		.select(prefixedColumns(memoryFacts, "fact"))
		.from(derivedFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				inArray(memoryFacts.source, [
					"consolidation://observation",
					"consolidation://standing_summary",
				]),
				options.tediId
					? sql`(${memoryFacts.tediId} = ${options.tediId} OR ${memoryFacts.tediId} IS NULL)`
					: isNull(memoryFacts.tediId),
				sql`(${memoryFacts.visibility} IN ('org','shared') OR ${memoryFacts.tediId} = ${options.tediId ?? ""})`,
				sql`json_extract(${memoryFacts.metadata}, '$.consolidation') IS NOT NULL`,
				options.includeHistory
					? undefined
					: and(
							isNull(memoryFacts.validTo),
							isNull(memoryFacts.archivedAt),
							sql`json_extract(${memoryFacts.metadata}, '$.consolidation.isHistory') = 0`,
						),
				options.topicKey
					? sql`json_extract(${memoryFacts.metadata}, '$.consolidation.topicKey') = ${options.topicKey} OR (${memoryFacts.source} = 'consolidation://standing_summary' AND json_extract(${memoryFacts.metadata}, '$.consolidation.entityKey') = ${options.topicKey})`
					: undefined,
			),
		)
		.orderBy(desc(memoryFacts.updatedAt), asc(memoryFacts.id))
		.limit(Math.min(100, Math.max(1, options.limit ?? 25)));
}

/** Bring a cached summary into the static Home recall set even when only its raw sources ranked. */
export async function preferConsolidatedFacts(
	db: DbQueryClient,
	orgId: string,
	facts: MemoryFact[],
	tediId?: string,
) {
	if (!facts.length) return facts;
	const ids = facts.map((fact) => fact.id);
	const candidates = await db
		.select()
		.from(memoryFacts)
		.where(
			and(
				eq(memoryFacts.organizationId, orgId),
				inArray(memoryFacts.source, [
					"consolidation://observation",
					"consolidation://standing_summary",
				]),
				isNull(memoryFacts.validTo),
				isNull(memoryFacts.archivedAt),
				sql`(${memoryFacts.visibility} IN ('org', 'shared') OR (${memoryFacts.visibility} = 'private' AND ${memoryFacts.tediId} = ${tediId ?? ""}))`,
				sql`EXISTS (SELECT 1 FROM json_each(json_extract(${memoryFacts.metadata}, '$.consolidation.evidence.sources')) citation WHERE json_extract(citation.value, '$.id') IN (SELECT value FROM json_each(${JSON.stringify(ids)})))`,
			),
		)
		.orderBy(desc(memoryFacts.updatedAt), asc(memoryFacts.id))
		.limit(50);
	const merged = new Map(
		[...candidates.filter((fact) => readConsolidation(fact)), ...facts].map(
			(fact) => [fact.id, fact],
		),
	);
	return filterConsolidatedEvidence(db, orgId, [...merged.values()]);
}
