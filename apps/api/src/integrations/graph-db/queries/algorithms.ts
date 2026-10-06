/**
 * GDS Algorithm Queries — Graph Data Science operations
 *
 * These wrap the Neo4j GDS algorithms used by the context-graph projection.
 *
 * Algorithms used:
 * - FastRP: Structural embeddings from graph topology
 * - Louvain: Community/cluster detection
 * - PageRank: Influence/importance scoring
 */

import {
	MIN_EXPLANATION_EDGE_STRENGTH,
	MIN_EXPLANATION_FACT_CONFIDENCE,
} from "./quality";

// ============================================================================
// Graph Projection Management
// ============================================================================

/**
 * Create or replace the fact relationship graph projection.
 * Must be called before running GDS algorithms.
 *
 * Uses Cypher Aggregation projection (GDS 2.5+ / AuraDB compatible).
 * The old `gds.graph.project.cypher()` procedure is removed on AuraDB —
 * replaced by the `gds.graph.project()` aggregation function.
 * AuraDB requires `memory` parameter (minimum "2GB").
 */
export function projectFactGraph(
	orgId: string,
	graphName = `fact-graph-${orgId}`,
) {
	return {
		query: `
			MATCH (source:Fact {orgId: $orgId})-[r]->(target:Fact {orgId: $orgId})
			WHERE source.archivedAt IS NULL
			  AND target.archivedAt IS NULL
			  AND source.validTo IS NULL
			  AND target.validTo IS NULL
			  AND source.confidence >= $minFactConfidence
			  AND target.confidence >= $minFactConfidence
			  AND coalesce(r.strength, 1.0) >= $minEdgeStrength
			  AND type(r) IN ['CAUSED_BY', 'CONTRADICTS', 'SUPERSEDES', 'APPLIES_TO', 'LEARNED_FROM', 'REQUIRES', 'RELATED_TO']
			WITH gds.graph.project(
				$graphName,
				source,
				target,
				{
					sourceNodeProperties: source { .confidence, .accessCount },
					targetNodeProperties: target { .confidence, .accessCount },
					relationshipProperties: r { .strength }
				},
				{ memory: '2GB' }
			) AS g
			RETURN g.graphName AS graphName, g.nodeCount AS nodeCount, g.relationshipCount AS relationshipCount
		`,
		params: {
			orgId,
			graphName,
			minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
			minEdgeStrength: MIN_EXPLANATION_EDGE_STRENGTH,
		},
	};
}

/**
 * Drop a graph projection (cleanup after algorithm runs).
 */
export function dropProjection(projectionName: string) {
	return {
		query: `
			CALL gds.graph.drop($projectionName, false)
			YIELD graphName
			RETURN graphName
		`,
		params: { projectionName },
	};
}

/**
 * List a bounded page of projection names owned by one tenant refresh prefix.
 *
 * The caller requests one row beyond its cleanup ceiling so it can detect that
 * another bounded cleanup retry is required.
 */
export function listProjectionsByPrefix(
	projectionPrefix: string,
	excludedProjectionName: string,
	limit: number,
) {
	return {
		query: `
			CALL gds.graph.list()
			YIELD graphName
			WHERE graphName STARTS WITH $projectionPrefix
			  AND graphName <> $excludedProjectionName
			RETURN graphName
			ORDER BY graphName
			LIMIT $limit
		`,
		params: {
			projectionPrefix,
			excludedProjectionName,
			limit,
		},
	};
}

// ============================================================================
// FastRP — Structural Embeddings
// ============================================================================

/**
 * Generate FastRP structural embeddings for all facts in an org.
 * These capture graph topology — facts in similar positions get similar vectors.
 * Write back to Fact nodes as `structuralEmbedding` property.
 */
export function runFastRP(
	orgId: string,
	embeddingDimension: number = 128,
	graphName = `fact-graph-${orgId}`,
) {
	return {
		query: `
			CALL gds.fastRP.mutate($graphName, {
				embeddingDimension: $embeddingDimension,
				mutateProperty: 'structuralEmbedding',
				iterationWeights: [0.0, 1.0, 1.0, 1.0],
				relationshipWeightProperty: 'strength'
			})
			YIELD nodePropertiesWritten, computeMillis
			RETURN nodePropertiesWritten, computeMillis
		`,
		params: { graphName, embeddingDimension },
	};
}

/**
 * Write FastRP embeddings from the in-memory projection back to the database.
 */
export function writeBackFastRP(
	orgId: string,
	graphName = `fact-graph-${orgId}`,
) {
	return {
		query: `
			CALL gds.graph.nodeProperties.write($graphName, ['structuralEmbedding'])
			YIELD propertiesWritten
			RETURN propertiesWritten
		`,
		params: { graphName },
	};
}

/**
 * Ensure the runtime vector index used by findStructurallySimilar() exists.
 *
 * FastRP writes a 128-dimensional list<float> to Fact.structuralEmbedding.
 * db.index.vector.queryNodes() requires an explicit Neo4j vector index; without
 * this step structural similarity fails even when embeddings were written.
 */
export function ensureStructuralEmbeddingIndex(
	embeddingDimension: number = 128,
) {
	const dimensions = Number.isFinite(embeddingDimension)
		? Math.max(1, Math.trunc(embeddingDimension))
		: 128;
	return {
		query: `
			CREATE VECTOR INDEX fact_structural_embedding IF NOT EXISTS
			FOR (f:Fact) ON (f.structuralEmbedding)
			OPTIONS {
				indexConfig: {
					\`vector.dimensions\`: ${dimensions},
					\`vector.similarity_function\`: 'cosine'
				}
			}
		`,
		params: {},
	};
}

// ============================================================================
// Louvain — Community Detection
// ============================================================================

/**
 * Persist Louvain assignments on Fact nodes for admission-gated read paths.
 */
export function runLouvainAndWriteBack(
	orgId: string,
	graphName = `fact-graph-${orgId}`,
) {
	return {
		query: `
			CALL gds.louvain.stream($graphName, {
				relationshipWeightProperty: 'strength'
			})
			YIELD nodeId, communityId
			WITH gds.util.asNode(nodeId) AS fact, communityId
			WHERE fact.orgId = $orgId
			SET fact.communityId = communityId
			RETURN count(*) AS updated
		`,
		params: { graphName, orgId },
	};
}

// ============================================================================
// Combined Algorithm Pipeline
// ============================================================================

/**
 * Full algorithm refresh pipeline — run after bulk data changes.
 *
 * Single projection for all algorithms (AuraDB spins up a 2GB GDS Session
 * per projection — reusing one avoids the ~60s cold-start penalty).
 *
 * Steps: drop stale → clear derived properties → project → ensure vector
 *        index → FastRP mutate/writeback → PageRank writeback → Louvain
 *        writeback → cleanup.
 *
 * Returns the query sequence (caller runs them in order).
 */
export function getRefreshPipeline(
	orgId: string,
	options?: {
		epoch?: string;
		sourceWatermark?: number;
		graphName?: string;
	},
) {
	const graphName = options?.graphName ?? `fact-graph-${orgId}`;
	return [
		{ step: "drop_existing", ...dropProjection(graphName) },
		{
			step: "clear_stale_properties",
			...clearDerivedProperties(orgId),
		},
		{ step: "project", ...projectFactGraph(orgId, graphName) },
		{
			step: "ensure_structural_index",
			...ensureStructuralEmbeddingIndex(),
		},
		{ step: "fastrp", ...runFastRP(orgId, 128, graphName) },
		{ step: "fastrp_writeback", ...writeBackFastRP(orgId, graphName) },
		{
			step: "fastrp_watermark",
			...watermarkFastRP(orgId, options),
		},
		{
			step: "pagerank_writeback",
			...runPageRankAndWriteBack(orgId, options, graphName),
		},
		{
			step: "louvain_writeback",
			...runLouvainAndWriteBack(orgId, graphName),
		},
		{ step: "cleanup", ...dropProjection(graphName) },
	];
}

export function clearDerivedProperties(orgId: string) {
	return {
		query: `
			MATCH (f:Fact {orgId: $orgId})
			REMOVE f.pageRank,
				f.pageRankEpoch,
				f.pageRankSourceWatermark,
				f.pageRankComputedAt,
				f.structuralEmbedding,
				f.structuralEmbeddingEpoch,
				f.structuralEmbeddingSourceWatermark,
				f.structuralEmbeddingComputedAt,
				f.communityId
			RETURN count(f) AS cleared
		`,
		params: { orgId },
	};
}

export function watermarkFastRP(
	orgId: string,
	options?: { epoch?: string; sourceWatermark?: number },
) {
	return {
		query: `
			MATCH (f:Fact {orgId: $orgId})
			WHERE f.structuralEmbedding IS NOT NULL
			SET f.structuralEmbeddingEpoch = $epoch,
				f.structuralEmbeddingSourceWatermark = $sourceWatermark,
				f.structuralEmbeddingComputedAt = datetime()
			RETURN count(f) AS updated
		`,
		params: {
			orgId,
			epoch: options?.epoch ?? null,
			sourceWatermark: options?.sourceWatermark ?? null,
		},
	};
}

/**
 * Run PageRank and write scores directly to Fact nodes in one query.
 * Avoids a separate projection — runs on the existing in-memory graph.
 */
export function runPageRankAndWriteBack(
	orgId: string,
	options?: { epoch?: string; sourceWatermark?: number },
	graphName = `fact-graph-${orgId}`,
) {
	return {
		query: `
			CALL gds.pageRank.stream($graphName, {
				relationshipWeightProperty: 'strength',
				dampingFactor: 0.85,
				maxIterations: 20
			})
			YIELD nodeId, score AS pageRank
			WITH gds.util.asNode(nodeId) AS fact, pageRank
			WHERE fact.orgId = $orgId
			SET fact.pageRank = pageRank,
				fact.pageRankEpoch = $epoch,
				fact.pageRankSourceWatermark = $sourceWatermark,
				fact.pageRankComputedAt = datetime()
			RETURN count(*) AS updated
		`,
		params: {
			graphName,
			orgId,
			epoch: options?.epoch ?? null,
			sourceWatermark: options?.sourceWatermark ?? null,
		},
	};
}
