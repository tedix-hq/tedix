/** Canonical D1/graph context assembly. Semantic recall runs in Agent Memory. */
import type { DbClient } from "@tedix/db/client";
import { getDomainByName } from "@tedix/db/queries/memory-graph/domains";
import { searchFactsWithVisibility } from "@tedix/db/queries/memory-graph/fact-search";
import { recordFactAccess } from "@tedix/db/queries/memory-graph/facts";
import type { MemoryFact } from "@tedix/db/schema/memory-graph";
import type { GraphClient } from "../integrations/graph-db/neo4j";
export interface AssembleParams {
	query: string;
	orgId: string;
	tediId: string;
	domains?: string[];
	factTypes?: string[];
	maxTokens?: number;
}
export interface AssembleResult {
	context: string;
	factCount: number;
	sources: Array<{ factId: string; domain: string; confidence: number }>;
}
const influenceCache = new Map<
	string,
	{ scores: Map<string, number>; fetchedAt: number }
>();
export function invalidateInfluenceCache(orgId?: string): void {
	if (orgId) influenceCache.delete(orgId);
	else influenceCache.clear();
}
function terms(query: string): string[] {
	return [
		...new Set(
			query
				.toLocaleLowerCase()
				.normalize("NFKC")
				.split(/[^\p{L}\p{N}_-]+/u)
				.filter((term) => term.length >= 2),
		),
	].slice(0, 24);
}
function score(fact: MemoryFact, queryTerms: string[]): number {
	const text = `${fact.summary ?? ""}\n${fact.content}`.toLocaleLowerCase();
	const matches = queryTerms.reduce(
		(n, term) => n + (text.includes(term) ? 1 : 0),
		0,
	);
	return (
		(queryTerms.length ? matches / queryTerms.length : 0) * 0.65 +
		fact.confidence * 0.35 +
		(fact.priority === "core" ? 0.2 : 0)
	);
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
	const domainIds = new Set<string>();
	for (const name of params.domains ?? []) {
		const domain = await getDomainByName(db, params.orgId, name);
		if (domain) domainIds.add(domain.id);
	}
	const requestedTypes = new Set(params.factTypes ?? []);
	const queryTerms = terms(params.query);
	const candidates = await searchFactsWithVisibility(db, {
		orgId: params.orgId,
		visibilityTediId: params.tediId,
		minConfidence: 0.3,
		limit: 100,
	});
	const ranked = candidates
		.filter(
			(fact) =>
				domainIds.size === 0 ||
				Boolean(fact.domainId && domainIds.has(fact.domainId)),
		)
		.filter(
			(fact) => requestedTypes.size === 0 || requestedTypes.has(fact.factType),
		)
		.map((fact) => ({ fact, score: score(fact, queryTerms) }));
	if (graphClient)
		try {
			const map = await influences(graphClient, params.orgId);
			for (const item of ranked) {
				const rank = map.get(item.fact.id);
				if (rank !== undefined)
					item.score *= rank > 0.1 ? 1.2 : rank > 0.05 ? 1.1 : 1;
			}
		} catch {
			/* optional projection */
		}
	ranked.sort((a, b) => b.score - a.score);
	const selected = ranked.slice(0, 25);
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
