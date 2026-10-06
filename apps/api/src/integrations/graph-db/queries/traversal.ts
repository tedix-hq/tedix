/**
 * Traversal Queries — Path finding and deep graph exploration
 *
 * Native Cypher variable-length path matching for the graph projection.
 */

import {
	boundedGraphInteger,
	MIN_EXPLANATION_EDGE_STRENGTH,
	MIN_EXPLANATION_FACT_CONFIDENCE,
} from "./quality";

// ============================================================================
// Shortest Path
// ============================================================================

/**
 * Find the shortest path between two facts through the knowledge graph.
 * "How are these two facts connected?"
 */
export function shortestPath(
	factIdA: string,
	factIdB: string,
	orgId: string,
	maxHops: number = 6,
) {
	const boundedHops = boundedGraphInteger(maxHops, 6, 12);
	return {
		query: `
			MATCH (a:Fact {id: $factIdA, orgId: $orgId}),
				(b:Fact {id: $factIdB, orgId: $orgId})
			MATCH path = shortestPath((a)-[*..${boundedHops}]-(b))
			WHERE all(n IN nodes(path) WHERE n:Fact
				AND n.orgId = $orgId
				AND n.archivedAt IS NULL
				AND n.validTo IS NULL
				AND n.confidence >= $minFactConfidence)
				AND all(r IN relationships(path) WHERE coalesce(r.strength, 1.0) >= $minEdgeStrength)
			RETURN [n IN nodes(path) | n.id] AS factIds,
				[r IN relationships(path) | type(r)] AS relationTypes,
				length(path) AS hops
		`,
		params: {
			factIdA,
			factIdB,
			orgId,
			minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
			minEdgeStrength: MIN_EXPLANATION_EDGE_STRENGTH,
		},
	};
}

// ============================================================================
// Deep Traversal
// ============================================================================

/**
 * Deep graph traversal from a starting fact.
 * Resolves the bounded traversal in a single Cypher query.
 */
export function deepTraversal(
	startFactId: string,
	orgId: string,
	maxDepth: number = 3,
	maxNodes: number = 100,
) {
	const boundedDepth = boundedGraphInteger(maxDepth, 3, 8);
	const boundedMaxNodes = boundedGraphInteger(maxNodes, 100, 500);
	return {
		query: `
			MATCH path = (start:Fact {id: $startFactId, orgId: $orgId})-[*1..${boundedDepth}]-(related:Fact)
			WHERE all(n IN nodes(path) WHERE n:Fact
				AND n.orgId = $orgId
				AND n.archivedAt IS NULL
				AND n.validTo IS NULL
				AND n.confidence >= $minFactConfidence)
				AND all(r IN relationships(path) WHERE coalesce(r.strength, 1.0) >= $minEdgeStrength)
			WITH related, min(length(path)) AS depth
			ORDER BY depth, related.confidence DESC
			LIMIT $maxNodes
			WITH collect({
				factId: related.id,
				content: related.content,
				summary: related.summary,
				factType: related.factType,
				confidence: related.confidence,
				priority: related.priority,
				domainId: related.domainId,
				tediId: related.tediId,
				validTo: related.validTo,
				archivedAt: related.archivedAt,
				depth: depth
			}) AS facts,
			collect(related.id) + [$startFactId] AS factIds
			OPTIONAL MATCH (a:Fact)-[r]-(b:Fact)
			WHERE a.id IN factIds
				AND b.id IN factIds
				AND a.orgId = $orgId
				AND b.orgId = $orgId
				AND a.archivedAt IS NULL
				AND b.archivedAt IS NULL
				AND a.validTo IS NULL
				AND b.validTo IS NULL
				AND a.confidence >= $minFactConfidence
				AND b.confidence >= $minFactConfidence
				AND coalesce(r.strength, 1.0) >= $minEdgeStrength
			WITH facts,
				collect(DISTINCT CASE WHEN r IS NULL THEN null ELSE {
					sourceFactId: startNode(r).id,
					targetFactId: endNode(r).id,
					relationType: coalesce(r.relationType, toLower(type(r))),
					strength: coalesce(r.strength, 1.0),
					context: r.context
				} END) AS rawEdges
			RETURN facts, [edge IN rawEdges WHERE edge IS NOT NULL] AS edges
		`,
		params: {
			startFactId,
			orgId,
			maxNodes: boundedMaxNodes,
			minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
			minEdgeStrength: MIN_EXPLANATION_EDGE_STRENGTH,
		},
	};
}
