/** Canonical memory context assembled from bounded hybrid recall. */
import type { DbClient } from "@tedix/db/client";
import { getDomainByName } from "@tedix/db/queries/memory-graph/domains";
import { recordFactAccess } from "@tedix/db/queries/memory-graph/facts";
import type { MemoryFact } from "@tedix/db/schema/memory-graph";
import type { GraphClient } from "../integrations/graph-db/neo4j";
import {
	boundRecall,
	HYBRID_RECALL_BUDGET_MS,
	recallMemoryFacts,
	type RecallEnvironment,
	type RecallProvenance,
} from "./memory-hybrid-recall";
export interface AssembleParams {
	query: string;
	orgId: string;
	tediId: string;
	domains?: string[];
	factTypes?: string[];
	maxTokens?: number;
	env?: RecallEnvironment;
}
export interface AssembleResult {
	context: string;
	factCount: number;
	sources: Array<{
		factId: string;
		domain: string;
		confidence: number;
		provenance: RecallProvenance;
	}>;
}
const influenceCache = new Map<
	string,
	{ scores: Map<string, number>; fetchedAt: number }
>();
export function invalidateInfluenceCache(orgId?: string): void {
	if (orgId) influenceCache.delete(orgId);
	else influenceCache.clear();
}
async function influences(
	graph: GraphClient,
	orgId: string,
): Promise<Map<string, number>> {
	const cached = influenceCache.get(orgId);
	if (cached && Date.now() - cached.fetchedAt < 7_200_000) return cached.scores;
	const rows = await graph.getInfluenceScores(orgId);
	const scores = new Map(rows.map((row) => [row.factId, row.pageRank]));
	influenceCache.set(orgId, { scores, fetchedAt: Date.now() });
	return scores;
}
function section(fact: MemoryFact, tediId: string): string {
	if (fact.visibility === "org") return "Org Knowledge";
	if (fact.visibility === "shared") return "Shared Knowledge";
	return fact.tediId === tediId ? "Your Knowledge" : "Expert Insights";
}
export async function assembleContext(
	db: DbClient,
	params: AssembleParams,
	graphClient?: GraphClient,
): Promise<AssembleResult> {
	const end = performance.now() + HYBRID_RECALL_BUDGET_MS;
	const domains = await boundRecall(
		() =>
			Promise.all(
				(params.domains ?? []).map((name) =>
					getDomainByName(db, params.orgId, name),
				),
			),
		100,
		[],
	);
	const domainIds = new Set(
		domains.flatMap((domain) => (domain ? [domain.id] : [])),
	);
	if (params.domains?.length && domainIds.size === 0)
		return { context: "", factCount: 0, sources: [] };
	const ranked = await recallMemoryFacts(db, {
		orgId: params.orgId,
		tediId: params.tediId,
		query: params.query,
		domainIds: [...domainIds],
		factTypes: params.factTypes,
		env: params.env,
		minConfidence: 0.3,
		topK: 25,
		budgetMs: end - performance.now(),
	});
	if (graphClient && ranked.some((item) => item.provenance.fallback)) {
		const map = await boundRecall(
			() => influences(graphClient, params.orgId),
			Math.min(50, end - performance.now()),
			new Map<string, number>(),
		);
		for (const item of ranked) {
			const rank = map.get(item.fact.id);
			if (rank !== undefined)
				item.score *= rank > 0.1 ? 1.2 : rank > 0.05 ? 1.1 : 1;
		}
		ranked.sort((a, b) => b.score - a.score);
	}
	const selected = ranked.slice(0, 25);
	const provenanceById = new Map(
		selected.map((item) => [item.factId, item.provenance]),
	);
	const grouped = new Map<string, MemoryFact[]>();
	for (const { fact } of selected) {
		const title = section(fact, params.tediId);
		grouped.set(title, [...(grouped.get(title) ?? []), fact]);
	}
	const maxChars = (params.maxTokens ?? 4_000) * 4;
	const sources: AssembleResult["sources"] = [];
	const sections: string[] = [];
	let used = 0;
	for (const title of [
		"Org Knowledge",
		"Your Knowledge",
		"Shared Knowledge",
		"Expert Insights",
	]) {
		const lines: string[] = [];
		for (const fact of grouped.get(title) ?? []) {
			const line = `- ${fact.summary || fact.content} (confidence: ${fact.confidence.toFixed(2)})`;
			if (used + line.length > maxChars) break;
			used += line.length;
			lines.push(line);
			sources.push({
				factId: fact.id,
				domain: fact.domainId ?? "unknown",
				confidence: fact.confidence,
				provenance: provenanceById.get(fact.id)!,
			});
			void recordFactAccess(db, fact.id).catch(() => undefined);
		}
		if (lines.length) sections.push(`## ${title}\n${lines.join("\n")}`);
	}
	return {
		context: sections.length
			? `# Memory Context\n\n${sections.join("\n\n")}`
			: "",
		factCount: sources.length,
		sources,
	};
}
