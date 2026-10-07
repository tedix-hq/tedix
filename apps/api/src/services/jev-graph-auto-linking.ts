import {
	listAutoLinkFacts,
	createAutoLinkEdge,
	type AutoLinkScope,
	type AutoLinkFact,
} from "@tedix/db/queries/memory-graph/auto-linking";
import { getEdgesForFacts } from "@tedix/db/queries/memory-graph/edges";
import { executeJevJudgment } from "./jev-judgment";
import { resolveMemoryJudgmentRoute } from "./jev-memory-policy";
import {
	graphRelationRequest,
	resolveGraphRelation,
	GRAPH_RELATION_RECIPE,
	type GraphRelationProposal,
} from "./jev-graph-relations";

export const GRAPH_AUTO_LINK_MAX_JUDGMENTS = 12;
export const GRAPH_AUTO_LINK_MIN_SUPPORT = 0.5;
/** Candidate ranking only; keyword overlap never establishes a relation. */
export function graphCandidatePairs(facts: AutoLinkFact[]) {
	const pairs: Array<{ a: AutoLinkFact; b: AutoLinkFact; overlap: number }> =
		[];
	for (let i = 0; i < facts.length; i++)
		for (let j = i + 1; j < facts.length; j++) {
			const a = facts[i]!,
				b = facts[j]!;
			if (a.domainId !== b.domainId || a.organizationId !== b.organizationId)
				continue;
			const privacy = (fact: AutoLinkFact) =>
				fact.visibility === "private" ? `private:${fact.tediId}` : "public";
			if (privacy(a) !== privacy(b)) continue;
			const tokens = (s: string) =>
				new Set(s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []);
			const left = tokens(a.content),
				right = tokens(b.content);
			pairs.push({
				a,
				b,
				overlap: [...left].filter((word) => right.has(word)).length,
			});
		}
	return pairs.sort(
		(a, b) =>
			b.overlap - a.overlap ||
			a.a.id.localeCompare(b.a.id) ||
			a.b.id.localeCompare(b.b.id),
	);
}
/**
 * Default bounded automatic linking; unavailable evidence never falls back to heuristic edges.
 * In shadow mode (the tenant default) proposals are judged and returned but no edge is written.
 */
export async function autoLinkFactsWithJev(
	input: Pick<
		Parameters<typeof executeJevJudgment>[0],
		"db" | "env" | "context"
	> & { scope: AutoLinkScope; dryRun?: boolean; maxEdges?: number },
) {
	const maxEdges = Math.max(0, Math.min(50, Math.floor(input.maxEdges ?? 50)));
	const proposals: Array<GraphRelationProposal & { context: string }> = [];
	const idle = {
		proposals,
		edgesCreated: 0,
		judgments: 0,
		domainsScanned: 0,
		mode: "shadow" as "shadow" | "enforce",
	};
	if (!Number.isFinite(maxEdges) || maxEdges === 0) return idle;
	const route = await resolveMemoryJudgmentRoute(
		input.db,
		input.scope.organizationId,
		"graphLinking",
	);
	if (!route) return idle;
	const dryRun = input.dryRun || route.mode === "shadow";
	const facts = await listAutoLinkFacts(input.db, input.scope);
	const edges = await getEdgesForFacts(
		input.db,
		facts.map((f) => f.id),
	);
	const counts = new Map<string, number>();
	const existing = new Set<string>();
	const key = (a: string, b: string) => [a, b].sort().join(":");
	for (const edge of edges) {
		for (const id of [edge.sourceFactId, edge.targetFactId])
			counts.set(id, (counts.get(id) ?? 0) + 1);
		existing.add(key(edge.sourceFactId, edge.targetFactId));
	}
	let judgments = 0,
		edgesCreated = 0;
	for (const { a, b } of graphCandidatePairs(facts)) {
		if (
			judgments >= GRAPH_AUTO_LINK_MAX_JUDGMENTS ||
			proposals.length >= maxEdges
		)
			break;
		if (
			existing.has(key(a.id, b.id)) ||
			(counts.get(a.id) ?? 0) >= 20 ||
			(counts.get(b.id) ?? 0) >= 20
		)
			continue;
		const pair = {
			a: { ...a, sourceRef: a.source ?? undefined },
			b: { ...b, sourceRef: b.source ?? undefined },
		};
		const request = graphRelationRequest(pair);
		if (!request) continue;
		judgments++;
		let result;
		try {
			result = await executeJevJudgment({
				...input,
				...request,
				context: {
					...input.context,
					organizationId: input.scope.organizationId,
					tediId: input.scope.tediId,
				},
				source: "memory:graph-link",
				billingSource: "system",
				sessionType: input.scope.tediId ? "tedi" : "unattributed",
				model: route.model,
				transport: route.transport,
				timeoutMs: 5000,
			});
		} catch {
			console.warn(
				"[jev-graph-link] judgment unavailable; stopping bounded pass",
			);
			break;
		}
		if (!result) break;
		const proposal = resolveGraphRelation(
			result,
			pair,
			GRAPH_AUTO_LINK_MIN_SUPPORT,
		);
		if (!proposal) continue;
		const context = `${GRAPH_RELATION_RECIPE}; support=${result.answers.sourceSupport.noul}; advisory relation, not lifecycle invalidation`;
		proposals.push({ ...proposal, context });
		if (!dryRun) {
			const source = proposal.sourceFactId === a.id ? a : b,
				target = proposal.targetFactId === b.id ? b : a;
			const created = await createAutoLinkEdge(input.db, input.scope, {
				id: crypto.randomUUID(),
				source,
				target,
				relationType: proposal.relationType,
				context,
			});
			if (created) {
				edgesCreated++;
				for (const id of [a.id, b.id])
					counts.set(id, (counts.get(id) ?? 0) + 1);
			}
		}
		if (dryRun)
			for (const id of [a.id, b.id]) counts.set(id, (counts.get(id) ?? 0) + 1);
		existing.add(key(a.id, b.id));
	}
	if (route.mode === "shadow" && judgments > 0)
		console.info("[jev-graph-link] shadow proposals not applied", {
			organizationId: input.scope.organizationId,
			judgments,
			model: route.model,
			proposals: proposals.map(
				({ sourceFactId, targetFactId, relationType }) => ({
					sourceFactId,
					targetFactId,
					relationType,
				}),
			),
		});
	return {
		proposals,
		edgesCreated,
		judgments,
		domainsScanned: new Set(facts.map((f) => f.domainId)).size,
		mode: route.mode,
	};
}
