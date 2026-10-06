/**
 * Fact Queries — Graph-powered fact operations
 *
 * These are the Cypher query templates for fact-related operations.
 * Each function returns { query, params } for driver-agnostic execution.
 */

import {
	boundedGraphInteger,
	MIN_EXPLANATION_EDGE_STRENGTH,
	MIN_EXPLANATION_FACT_CONFIDENCE,
} from "./quality";

// ============================================================================
// Structural Similarity (FastRP-based)
// ============================================================================

/**
 * Find facts structurally similar to a given fact using FastRP embeddings.
 * Structural similarity captures graph topology — facts connected to similar
 * nodes rank high even if their text content is completely different.
 */
export function findStructurallySimilar(
	factId: string,
	orgId: string,
	topK: number = 10,
) {
	return {
		query: `
			MATCH (target:Fact {id: $factId, orgId: $orgId})
			WHERE target.structuralEmbedding IS NOT NULL
				AND target.archivedAt IS NULL
				AND target.validTo IS NULL
				AND target.confidence >= $minFactConfidence
			CALL db.index.vector.queryNodes(
				'fact_structural_embedding',
				$topK + 1,
				target.structuralEmbedding
			) YIELD node, score
			WHERE node.orgId = $orgId
				AND node.id <> $factId
				AND node.archivedAt IS NULL
				AND node.validTo IS NULL
				AND node.confidence >= $minFactConfidence
			RETURN node.id AS factId, score
			ORDER BY score DESC
			LIMIT $topK
		`,
		params: {
			factId,
			orgId,
			topK,
			minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
		},
	};
}

// ============================================================================
// Fact Edges
// ============================================================================

/**
 * Get all edges for a fact with optional filters.
 * Replaces N+1 D1 queries with a single Cypher traversal.
 */
export function getEdges(
	factId: string,
	orgId: string,
	options?: { relationType?: string; direction?: "in" | "out" | "both" },
) {
	const direction = options?.direction ?? "both";
	const relFilter = options?.relationType
		? `{relationType: $relationType}`
		: "";

	// Build direction-specific pattern
	let pattern: string;
	switch (direction) {
		case "in":
			pattern = `(other)-[r ${relFilter}]->(f)`;
			break;
		case "out":
			pattern = `(f)-[r ${relFilter}]->(other)`;
			break;
		default:
			pattern = `(f)-[r ${relFilter}]-(other)`;
	}

	return {
		query: `
			MATCH (f:Fact {id: $factId, orgId: $orgId})
			MATCH ${pattern}
			WHERE other:Fact
				AND other.orgId = $orgId
				AND f.archivedAt IS NULL
				AND other.archivedAt IS NULL
				AND f.validTo IS NULL
				AND other.validTo IS NULL
				AND f.confidence >= $minFactConfidence
				AND other.confidence >= $minFactConfidence
				AND coalesce(r.strength, 1.0) >= $minEdgeStrength
			RETURN startNode(r).id AS sourceFactId,
				endNode(r).id AS targetFactId,
				coalesce(r.relationType, toLower(type(r))) AS relationType,
				r.strength AS strength,
				r.context AS context
		`,
		params: {
			factId,
			orgId,
			minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
			minEdgeStrength: MIN_EXPLANATION_EDGE_STRENGTH,
			...(options?.relationType ? { relationType: options.relationType } : {}),
		},
	};
}

// ============================================================================
// Fact Context Expansion
// ============================================================================

/**
 * Get a fact's neighborhood — the fact itself plus related facts within N hops.
 * Uses variable-length path matching — works on all Neo4j editions.
 */
export function getNeighborhoodSimple(
	factId: string,
	maxDepth: number = 2,
	orgId: string,
) {
	const boundedDepth = boundedGraphInteger(maxDepth, 2, 6);
	return {
		query: `
			MATCH path = (start:Fact {id: $factId, orgId: $orgId})-[*1..${boundedDepth}]-(related:Fact)
			WHERE all(n IN nodes(path) WHERE n:Fact
					AND n.orgId = $orgId
					AND n.archivedAt IS NULL
					AND n.validTo IS NULL
					AND n.confidence >= $minFactConfidence)
				AND all(r IN relationships(path) WHERE
					type(r) IN $allowedRelationTypes
					AND coalesce(r.strength, 1.0) >= $minEdgeStrength)
				AND related.id <> $factId
			WITH DISTINCT related, min(length(path)) AS depth
			RETURN related.id AS factId,
				related.summary AS summary,
				related.factType AS factType,
				related.confidence AS confidence,
				related.priority AS priority,
				depth
			ORDER BY depth, related.confidence DESC
			LIMIT 50
		`,
		params: {
			factId,
			orgId,
			allowedRelationTypes: [
				"CAUSED_BY",
				"CONTRADICTS",
				"SUPERSEDES",
				"APPLIES_TO",
				"LEARNED_FROM",
				"REQUIRES",
				"RELATED_TO",
				"PROMOTED_FROM",
			],
			minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
			minEdgeStrength: MIN_EXPLANATION_EDGE_STRENGTH,
		},
	};
}
