import { safeExceptionTopology } from "../../lib/safe-log-metadata";
import { createQueryRunner, type HttpClient } from "./neo4j-http";
import { toNumber } from "./neo4j-params";
import * as decisionQueries from "./queries/decisions";
import * as factQueries from "./queries/facts";
import { MIN_EXPLANATION_FACT_CONFIDENCE } from "./queries/quality";
import * as traversalQueries from "./queries/traversal";
import * as vizQueries from "./queries/visualization";
import type {
	CausalChain,
	Community,
	GraphEdge,
	GraphFact,
	GraphPath,
	GraphVisualizationData,
	InfluenceScore,
	SimilarDecision,
	SimilarFact,
	TraversalResult,
	VisualizationParams,
} from "./types";

export function createNeo4jReads(http: HttpClient) {
	const run = createQueryRunner(http);
	return {
		async findStructurallySimilar(
			factId: string,
			orgId: string,
			topK = 10,
		): Promise<SimilarFact[]> {
			return run(
				factQueries.findStructurallySimilar(factId, orgId, topK),
				(records) =>
					records.map((r) => ({
						factId: r.factId as string,
						score: toNumber(r.score),
						source: "structural" as const,
					})),
			);
		},

		async findSimilarDecisions(
			_query: string,
			orgId: string,
			options?: { category?: string; tediId?: string; topK?: number },
		): Promise<SimilarDecision[]> {
			return run(decisionQueries.findPrecedents(orgId, options), (records) =>
				records.map((r) => ({
					decisionId: r.decisionId as string,
					action: r.action as string,
					rationale: r.rationale as string,
					outcomeStatus: r.outcomeStatus as string,
					confidence: toNumber(r.confidence),
					score: toNumber(r.evidenceCount) / 10,
				})),
			);
		},

		async findPath(
			factIdA: string,
			factIdB: string,
			orgId: string,
			maxHops = 6,
		): Promise<GraphPath | null> {
			return run(
				traversalQueries.shortestPath(factIdA, factIdB, orgId, maxHops),
				(records) => {
					if (records.length === 0) return null;
					const r = records[0]!;
					return {
						factIds: r.factIds as string[],
						relationTypes: r.relationTypes as string[],
						hops: toNumber(r.hops),
					};
				},
			);
		},

		async getCausalChain(
			decisionId: string,
			orgId: string,
			maxDepth = 5,
		): Promise<CausalChain> {
			return run(
				decisionQueries.getCausalChain(decisionId, orgId, maxDepth),
				(records) => {
					if (records.length === 0) {
						return { decisionId, nodes: [], edges: [] };
					}
					const r = records[0]!;
					const upstream = (r.upstreamNodes ?? []) as Array<{
						id: string;
						type: string;
						label: string;
						depth: number;
					}>;
					const downstream = (r.downstreamNodes ?? []) as Array<{
						id: string;
						type: string;
						label: string;
						depth: number;
					}>;
					const rawEdges = (r.edges ?? []) as Array<{
						sourceFactId?: string;
						targetFactId?: string;
						relationType?: string;
					}>;
					const edgeMap = new Map<
						string,
						{ source: string; target: string; relationType: string }
					>();
					for (const edge of rawEdges) {
						if (!edge.sourceFactId || !edge.targetFactId) continue;
						const relationType = edge.relationType ?? "related_to";
						const key = `${edge.sourceFactId}:${relationType}:${edge.targetFactId}`;
						edgeMap.set(key, {
							source: edge.sourceFactId,
							target: edge.targetFactId,
							relationType,
						});
					}
					const nodes = [...upstream, ...downstream].filter((n) => n.id);
					return {
						decisionId,
						nodes: nodes.map((n) => ({
							id: n.id,
							type: n.type as "decision" | "fact",
							label: n.label ?? "",
							depth: toNumber(n.depth),
						})),
						edges: [...edgeMap.values()],
					};
				},
			);
		},

		async traverse(
			startFactId: string,
			orgId: string,
			maxDepth: number,
			maxNodes = 100,
		): Promise<TraversalResult> {
			return run(
				traversalQueries.deepTraversal(startFactId, orgId, maxDepth, maxNodes),
				(records) => {
					const facts = new Map<string, { fact: GraphFact; depth: number }>();
					if (records.length === 0) return { facts, edges: [] };

					const r = records[0]!;
					const rawFacts = (r.facts ?? []) as Array<Record<string, unknown>>;
					const rawEdges = (r.edges ?? []) as Array<Record<string, unknown>>;

					for (const fact of rawFacts) {
						const factId = fact.factId as string | undefined;
						if (!factId) continue;
						facts.set(factId, {
							fact: {
								id: factId,
								orgId,
								tediId: fact.tediId as string | null,
								domainId: fact.domainId as string | null,
								content: fact.content as string,
								summary: fact.summary as string | null,
								factType: fact.factType as string,
								confidence: toNumber(fact.confidence),
								validTo: fact.validTo as string | null,
								archivedAt: fact.archivedAt as string | null,
								priority: fact.priority as string | null,
								visibility: null,
								accessCount: 0,
								usageCount: 0,
								createdAt: null,
								updatedAt: null,
							},
							depth: toNumber(fact.depth),
						});
					}

					const edges = rawEdges
						.filter((edge) => edge.sourceFactId && edge.targetFactId)
						.map((edge) => ({
							sourceFactId: edge.sourceFactId as string,
							targetFactId: edge.targetFactId as string,
							relationType: edge.relationType as GraphEdge["relationType"],
							strength: toNumber(edge.strength),
							context: edge.context as string | null,
						}));

					return { facts, edges };
				},
			);
		},

		async getEdges(
			factId: string,
			orgId: string,
			options?: { relationType?: string; direction?: "in" | "out" | "both" },
		): Promise<GraphEdge[]> {
			return run(factQueries.getEdges(factId, orgId, options), (records) =>
				records.map((r) => ({
					sourceFactId: r.sourceFactId as string,
					targetFactId: r.targetFactId as string,
					relationType: r.relationType as GraphEdge["relationType"],
					strength: toNumber(r.strength),
					context: r.context as string | null,
				})),
			);
		},

		/** Reads persisted community assignments; never creates, runs, or drops a GDS projection. */
		async getCommunities(
			orgId: string,
			options?: { domainId?: string; minSize?: number },
		): Promise<Community[]> {
			try {
				return await run(
					{
						query: `
							MATCH (f:Fact {orgId: $orgId})
							WHERE f.communityId IS NOT NULL
								AND f.archivedAt IS NULL
								AND f.validTo IS NULL
								AND f.confidence >= $minFactConfidence
								AND ($domainId IS NULL OR f.domainId = $domainId)
							WITH f.communityId AS communityId,
								collect(f.id) AS factIds,
								count(*) AS size
							WHERE size >= $minSize
							RETURN communityId, factIds, size,
								null AS dominantDomain
							ORDER BY size DESC
						`,
						params: {
							orgId,
							domainId: options?.domainId ?? null,
							minSize: options?.minSize ?? 2,
							minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
						},
					},
					(records) =>
						records.map((r) => ({
							communityId: toNumber(r.communityId),
							factIds: r.factIds as string[],
							size: toNumber(r.size),
							dominantDomain: r.dominantDomain as string | null,
						})),
				);
			} catch (e) {
				// Persisted assignments are optional; callers degrade when absent.
				console.warn("[GraphDB] persisted community read failed", {
					exception: safeExceptionTopology(e),
				});
				return [];
			}
		},

		/** Reads persisted PageRank scores; never creates, runs, or drops a GDS projection. */
		async getInfluenceScores(
			orgId: string,
			options?: { domainId?: string; topK?: number },
		): Promise<InfluenceScore[]> {
			const topK = options?.topK ?? 20;

			try {
				return await run(
					{
						query: `
							MATCH (f:Fact {orgId: $orgId})
							WHERE f.pageRank IS NOT NULL
								AND f.archivedAt IS NULL
								AND f.validTo IS NULL
								AND f.confidence >= $minFactConfidence
								AND ($domainId IS NULL OR f.domainId = $domainId)
							RETURN f.id AS factId, f.pageRank AS pageRank,
								f.summary AS summary, f.factType AS factType
							ORDER BY f.pageRank DESC
							LIMIT $topK
						`,
						params: {
							orgId,
							topK,
							domainId: options?.domainId ?? null,
							minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
						},
					},
					(records) =>
						records.map((r) => ({
							factId: r.factId as string,
							pageRank: toNumber(r.pageRank),
							summary: r.summary as string | null,
							factType: r.factType as string,
						})),
				);
			} catch (e) {
				console.warn("[GraphDB] persisted PageRank read failed", {
					exception: safeExceptionTopology(e),
				});
				return [];
			}
		},
		async getVisualization(
			params: VisualizationParams,
		): Promise<GraphVisualizationData> {
			if (params.centerFactId) {
				return run(
					factQueries.getNeighborhoodSimple(
						params.centerFactId,
						params.depth ?? 2,
						params.orgId,
					),
					(records) => {
						const nodes = records.map((r) => ({
							id: r.factId as string,
							label: (r.summary ?? r.factType) as string,
							type: "fact" as const,
							properties: {
								factType: r.factType,
								confidence: r.confidence,
								priority: r.priority,
								depth: r.depth,
							},
						}));
						return { nodes, edges: [] };
					},
				);
			}

			return run(
				vizQueries.knowledgeMap({
					orgId: params.orgId,
					tediId: params.tediId,
					domainId: params.domainId,
					maxNodes: params.maxNodes,
				}),
				(records) => {
					if (records.length === 0) return { nodes: [], edges: [] };
					const r = records[0]!;
					// Filter out null entries from OPTIONAL MATCH (domain/edge can be null)
					const rawNodes = (r.nodes ?? []) as GraphVisualizationData["nodes"];
					const rawEdges = (r.edges ?? []) as GraphVisualizationData["edges"];
					return {
						nodes: rawNodes.filter((n) => n.id != null),
						edges: rawEdges.filter((e) => e.source != null && e.target != null),
					};
				},
			);
		},
	};
}
