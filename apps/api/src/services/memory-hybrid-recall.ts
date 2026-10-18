import type { DbClient } from "@tedix/db/client";
import {
	fallbackRecall,
	graphRecall,
	hydrateRecall,
	lexicalRecall,
	recallTerms,
	temporalRecall,
	type RecallCandidate,
	type RecallScope,
} from "@tedix/db/queries/memory-graph/hybrid-recall";
import type { MemoryFact } from "@tedix/db/schema/memory-graph";
import type { SearchResult } from "@tedix/api-contract/schemas/memory-graph";
import { recallCanonicalMemoryCandidates } from "../integrations/cloudflare/agent-memory";

export type RecallProvenance = NonNullable<SearchResult["provenance"]>;
export type RecallArm = RecallProvenance["arms"][number]["arm"];
export interface HybridRecallResult {
	factId: string;
	fact: MemoryFact;
	score: number;
	provenance: RecallProvenance;
}
export type RecallEnvironment = Partial<
	Pick<CloudflareEnv, "AI" | "AGENT_MEMORY">
>;
export const HYBRID_RECALL_BUDGET_MS = 750;

/** Bound optional work without leaving unhandled rejections or live timers. */
export async function boundRecall<T>(
	work: () => Promise<T>,
	ms: number,
	fallback: T,
): Promise<T> {
	if (ms <= 0) return fallback;
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			Promise.resolve()
				.then(work)
				.catch(() => fallback),
			new Promise<T>((resolve) => {
				timer = setTimeout(() => resolve(fallback), ms);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/** RRF uses ranks, so BM25, similarity and decay need no shared score scale. */
export function fuseRecall(
	arms: Partial<Record<RecallArm, RecallCandidate[]>>,
): Array<{
	factId: string;
	score: number;
	provenance: RecallProvenance;
}> {
	const merged = new Map<
		string,
		{ factId: string; score: number; provenance: RecallProvenance }
	>();
	for (const arm of ["lexical", "semantic", "graph", "temporal"] as const) {
		const seen = new Set<string>();
		for (const [index, candidate] of (arms[arm] ?? []).entries()) {
			if (seen.has(candidate.factId) || !Number.isFinite(candidate.score))
				continue;
			seen.add(candidate.factId);
			const item = merged.get(candidate.factId) ?? {
				factId: candidate.factId,
				score: 0,
				provenance: { arms: [], fusionScore: 0 },
			};
			// Graph neighbors are ordered by confidence, not query relevance.
			// Keep their expansion signal without overpowering query-ranked arms.
			item.score += (arm === "graph" ? 0.5 : 1) / (60 + index + 1);
			item.provenance.fusionScore = item.score;
			item.provenance.arms.push({
				arm,
				rank: index + 1,
				score: candidate.score,
			});
			merged.set(candidate.factId, item);
		}
	}
	return [...merged.values()].sort(
		(a, b) => b.score - a.score || a.factId.localeCompare(b.factId),
	);
}
export function legacyRecallScore(fact: MemoryFact, query: string): number {
	const terms = recallTerms(query);
	const text = `${fact.summary ?? ""}\n${fact.content}`.toLowerCase();
	return (
		(terms.length
			? terms.filter((term) => text.includes(term)).length / terms.length
			: 0) *
			0.65 +
		fact.confidence * 0.35 +
		(fact.priority === "core" ? 0.2 : 0)
	);
}

export async function recallMemoryFacts(
	db: DbClient,
	params: RecallScope & {
		query: string;
		topK?: number;
		env?: RecallEnvironment;
		budgetMs?: number;
	},
): Promise<HybridRecallResult[]> {
	if (!params.query.trim()) return [];
	const end =
		performance.now() +
		Math.min(
			HYBRID_RECALL_BUDGET_MS,
			Math.max(0, params.budgetMs ?? HYBRID_RECALL_BUDGET_MS),
		);
	const left = () => Math.max(0, end - performance.now());
	const topK = Math.min(100, Math.max(1, params.topK ?? 10));
	let missingIndex = false;
	const armBudget = Math.min(350, left());
	const [lexical, semantic, graph, temporal] = await Promise.all([
		boundRecall(
			async () => {
				try {
					return await lexicalRecall(db, params, params.query);
				} catch (error) {
					let cause: unknown = error;
					for (let depth = 0; depth < 4 && cause; depth++) {
						if (
							/no such (table|module).*memory_fact_fts|no such module.*fts5/i.test(
								String(cause),
							)
						)
							missingIndex = true;
						cause = cause instanceof Error ? cause.cause : undefined;
					}
					return [];
				}
			},
			armBudget,
			[],
		),
		boundRecall(
			() =>
				params.env?.AGENT_MEMORY
					? recallCanonicalMemoryCandidates(params.env.AGENT_MEMORY, {
							orgId: params.orgId,
							tediId: params.tediId,
							query: params.query,
							limit: 40,
						})
					: Promise.resolve([]),
			Math.min(150, left()),
			[],
		),
		boundRecall(() => graphRecall(db, params, params.query), armBudget, []),
		boundRecall(() => temporalRecall(db, params, params.query), armBudget, []),
	]);
	if (missingIndex) {
		const rows = await boundRecall(
			() => fallbackRecall(db, params),
			Math.min(300, left()),
			[],
		);
		return rows
			.map((fact) => ({
				factId: fact.id,
				fact,
				score: legacyRecallScore(fact, params.query),
				provenance: { arms: [], fusionScore: 0, fallback: true },
			}))
			.sort((a, b) => b.score - a.score || a.factId.localeCompare(b.factId))
			.slice(0, topK);
	}
	const fused = fuseRecall({ lexical, semantic, graph, temporal });
	// Hydrate all arm candidates before taking the rerank shortlist: private,
	// cross-tenant or expired semantic IDs cannot displace eligible candidates.
	const facts = await boundRecall(
		() =>
			hydrateRecall(
				db,
				params,
				fused.map((item) => item.factId),
			),
		Math.min(300, left()),
		[],
	);
	const byId = new Map(facts.map((fact) => [fact.id, fact]));
	let ranked: HybridRecallResult[] = fused.flatMap((item) => {
		const fact = byId.get(item.factId);
		return fact
			? [
					{
						...item,
						fact,
						provenance: {
							...item.provenance,
							replacesFactIds: fact.replacesFactIds,
						},
					},
				]
			: [];
	});
	const ai = params.env?.AI;
	if (ai && typeof ai.run === "function" && ranked.length > 1) {
		const shortlist = ranked.slice(0, 30);
		const tail = ranked.slice(30);
		const reranked = await boundRecall(
			async () => {
				// The generated Cloudflare type omits `query`; the published model API
				// requires it. Keep it in the request alongside the typed contexts.
				const input = {
					query: params.query.slice(0, 1024),
					contexts: shortlist.map((item) => ({
						text: `${item.fact.summary ?? ""}\n${item.fact.content}`.slice(
							0,
							4000,
						),
					})),
					top_k: shortlist.length,
				};
				const response = await ai.run("@cf/baai/bge-reranker-base", input);
				return response.response;
			},
			Math.min(100, left()),
			undefined,
		);
		if (reranked) {
			const scores = new Map<number, number>();
			for (const row of reranked) {
				if (
					typeof row.id === "number" &&
					Number.isInteger(row.id) &&
					row.id >= 0 &&
					row.id < shortlist.length &&
					typeof row.score === "number" &&
					Number.isFinite(row.score)
				)
					scores.set(row.id, row.score);
			}
			// An incomplete response must not silently discard RRF candidates.
			if (scores.size === shortlist.length) {
				ranked = shortlist
					.map((item, index) => ({
						...item,
						provenance: { ...item.provenance, rerankScore: scores.get(index)! },
					}))
					.sort(
						(a, b) =>
							b.provenance.rerankScore! - a.provenance.rerankScore! ||
							b.score - a.score,
					);
				ranked.push(...tail);
			}
		}
	}
	return ranked.slice(0, topK);
}
