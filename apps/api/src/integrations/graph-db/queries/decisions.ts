/**
 * Decision Queries — Rationale/precedent graph operations
 *
 * Powers: rationale_precedents, rationale_causal_chain MCP tools.
 * Each function returns { query, params } for driver-agnostic execution.
 */

import {
	boundedGraphInteger,
	MIN_EXPLANATION_EDGE_STRENGTH,
	MIN_EXPLANATION_FACT_CONFIDENCE,
} from "./quality";

// ============================================================================
// Precedent Discovery
// ============================================================================

/**
 * Find past decisions similar to a proposed action.
 * Uses shared evidence context — decisions that referenced similar facts
 * are structurally similar regardless of how they were described.
 */
export function findPrecedents(
	orgId: string,
	options?: { category?: string; tediId?: string; topK?: number },
) {
	const topK = options?.topK ?? 10;
	const filters: string[] = ["d.orgId = $orgId"];
	if (options?.category) filters.push("d.category = $category");
	if (options?.tediId) filters.push("d.tediId = $tediId");

	return {
		query: `
			MATCH (d:Decision)
			WHERE ${filters.join(" AND ")}
				AND d.outcomeStatus IN ['success', 'failure', 'partial']
			OPTIONAL MATCH (d)-[:INFORMED_BY]->(f:Fact)
			WHERE f.orgId = $orgId
				AND f.archivedAt IS NULL
				AND f.validTo IS NULL
				AND f.confidence >= $minFactConfidence
			WITH d, collect(f.id) AS evidenceIds, count(f) AS evidenceCount
			RETURN d.id AS decisionId,
				d.action AS action,
				d.rationale AS rationale,
				d.category AS category,
				d.outcomeStatus AS outcomeStatus,
				d.confidence AS confidence,
				d.createdAt AS createdAt,
				evidenceIds,
				evidenceCount
			ORDER BY d.createdAt DESC
			LIMIT $topK
		`,
		params: {
			orgId,
			...(options?.category ? { category: options.category } : {}),
			...(options?.tediId ? { tediId: options.tediId } : {}),
			topK,
			minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
		},
	};
}

/**
 * Find decisions that share evidence (common INFORMED_BY facts) with a given decision.
 * This is "structural precedent" — decisions that drew on similar knowledge.
 */
export function findDecisionsWithSharedEvidence(
	decisionId: string,
	orgId: string,
	topK: number = 10,
) {
	return {
		query: `
			MATCH (source:Decision {id: $decisionId, orgId: $orgId})-[:INFORMED_BY]->(f:Fact)<-[:INFORMED_BY]-(other:Decision)
			WHERE other.orgId = $orgId
				AND other.id <> $decisionId
				AND other.outcomeStatus IN ['success', 'failure', 'partial']
				AND f.orgId = $orgId
				AND f.archivedAt IS NULL
				AND f.validTo IS NULL
				AND f.confidence >= $minFactConfidence
			WITH other, count(DISTINCT f) AS sharedFacts, collect(DISTINCT f.id) AS sharedFactIds
			RETURN other.id AS decisionId,
				other.action AS action,
				other.rationale AS rationale,
				other.outcomeStatus AS outcomeStatus,
				other.confidence AS confidence,
				sharedFacts,
				sharedFactIds
			ORDER BY sharedFacts DESC
			LIMIT $topK
		`,
		params: {
			decisionId,
			orgId,
			topK,
			minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
		},
	};
}

// ============================================================================
// Causal Chain Traversal
// ============================================================================

/**
 * Trace the causal chain from a decision — upstream (what led to it)
 * and downstream (what it caused). Replaces BFS with native Cypher traversal.
 */
export function getCausalChain(
	decisionId: string,
	orgId: string,
	maxDepth: number = 5,
) {
	const boundedDepth = boundedGraphInteger(maxDepth, 5, 8);
	return {
		query: `
			MATCH (start:Decision {id: $decisionId, orgId: $orgId})
			// Upstream: what facts/decisions informed this one
			OPTIONAL MATCH upstream = (start)-[:INFORMED_BY|PRECEDED_BY*1..${boundedDepth}]-(upNode)
			WHERE (upNode:Fact OR upNode:Decision) AND upNode.orgId = $orgId
				AND all(n IN nodes(upstream) WHERE
					(n:Decision AND n.orgId = $orgId)
					OR (n:Fact AND n.orgId = $orgId
						AND n.archivedAt IS NULL
						AND n.validTo IS NULL
						AND n.confidence >= $minFactConfidence))
				AND all(r IN relationships(upstream) WHERE coalesce(r.strength, 1.0) >= $minEdgeStrength)
			WITH start,
				collect(DISTINCT {
					id: upNode.id,
					type: CASE WHEN upNode:Decision THEN 'decision' ELSE 'fact' END,
					label: COALESCE(upNode.action, upNode.summary, upNode.content),
					depth: length(upstream)
				}) AS upstreamNodes,
				reduce(edges = [], path IN collect(upstream) |
					edges + CASE WHEN path IS NULL THEN [] ELSE [
						rel IN relationships(path) | {
							sourceFactId: startNode(rel).id,
							targetFactId: endNode(rel).id,
							relationType: coalesce(rel.relationType, toLower(type(rel))),
							strength: coalesce(rel.strength, 1.0),
							context: rel.context
						}
					] END
				) AS upstreamEdges

			// Downstream: what this decision caused
			OPTIONAL MATCH downstream = (start)-[:CAUSED*1..${boundedDepth}]->(downNode)
			WHERE (downNode:Fact OR downNode:Decision) AND downNode.orgId = $orgId
				AND all(n IN nodes(downstream) WHERE
					(n:Decision AND n.orgId = $orgId)
					OR (n:Fact AND n.orgId = $orgId
						AND n.archivedAt IS NULL
						AND n.validTo IS NULL
						AND n.confidence >= $minFactConfidence))
				AND all(r IN relationships(downstream) WHERE coalesce(r.strength, 1.0) >= $minEdgeStrength)
			WITH start, upstreamNodes, upstreamEdges,
				collect(DISTINCT {
					id: downNode.id,
					type: CASE WHEN downNode:Decision THEN 'decision' ELSE 'fact' END,
					label: COALESCE(downNode.action, downNode.summary, downNode.content),
					depth: length(downstream)
				}) AS downstreamNodes,
				reduce(edges = [], path IN collect(downstream) |
					edges + CASE WHEN path IS NULL THEN [] ELSE [
						rel IN relationships(path) | {
							sourceFactId: startNode(rel).id,
							targetFactId: endNode(rel).id,
							relationType: coalesce(rel.relationType, toLower(type(rel))),
							strength: coalesce(rel.strength, 1.0),
							context: rel.context
						}
					] END
				) AS downstreamEdges

			RETURN start.id AS decisionId,
				start.action AS action,
				upstreamNodes,
				downstreamNodes,
				upstreamEdges + downstreamEdges AS edges
		`,
		params: {
			decisionId,
			orgId,
			minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
			minEdgeStrength: MIN_EXPLANATION_EDGE_STRENGTH,
		},
	};
}

// ============================================================================
// Decision Timeline
// ============================================================================
