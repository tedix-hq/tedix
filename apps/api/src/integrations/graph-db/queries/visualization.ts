/**
 * Visualization Queries — Graph data for Tedix OS dashboard
 *
 * Returns data formatted for NVL (Neo4j Visualization Library) or any
 * graph rendering library that consumes { nodes, edges } format.
 */

import {
	MIN_EXPLANATION_EDGE_STRENGTH,
	MIN_EXPLANATION_FACT_CONFIDENCE,
} from "./quality";

// ============================================================================
// Knowledge Map — Full fact graph for a tedi
// ============================================================================

/**
 * Get the knowledge graph centered on a tedi's facts.
 * Returns nodes (facts, domains) and edges (relationships).
 */
export function knowledgeMap(params: {
	orgId: string;
	tediId?: string;
	domainId?: string;
	maxNodes?: number;
}) {
	const { orgId, tediId, domainId, maxNodes = 100 } = params;
	const filters: string[] = [
		"f.orgId = $orgId",
		"f.archivedAt IS NULL",
		"f.validTo IS NULL",
		"f.confidence >= $minFactConfidence",
	];
	if (tediId) filters.push("f.tediId = $tediId");
	if (domainId) filters.push("f.domainId = $domainId");

	return {
		query: `
			// Get facts
			MATCH (f:Fact)
			WHERE ${filters.join(" AND ")}
			WITH f
			ORDER BY f.confidence DESC
			LIMIT $maxNodes

			// Get their relationships
			OPTIONAL MATCH (f)-[r]-(other:Fact)
			WHERE other.archivedAt IS NULL
				AND other.validTo IS NULL
				AND other.orgId = $orgId
				AND other.confidence >= $minFactConfidence
				AND coalesce(r.strength, 1.0) >= $minEdgeStrength

			// Get domains
			OPTIONAL MATCH (f)-[:IN_DOMAIN]->(d:Domain {orgId: $orgId})

			WITH collect(DISTINCT {
				id: f.id,
				label: COALESCE(f.summary, left(f.content, 80)),
				type: 'fact',
				properties: {
					factType: f.factType,
					confidence: f.confidence,
					priority: f.priority,
					visibility: f.visibility,
					domainId: f.domainId,
					tediId: f.tediId,
					pageRank: f.pageRank,
					communityId: f.communityId
				}
			}) AS factNodes,
			collect(DISTINCT {
				id: d.id,
				label: d.name,
				type: 'domain',
				properties: {description: d.description}
			}) AS rawDomainNodes,
			collect(DISTINCT CASE WHEN r IS NULL THEN null ELSE {
				source: startNode(r).id,
				target: endNode(r).id,
				type: type(r),
				properties: {strength: r.strength, context: r.context}
			} END) AS rawEdges

			RETURN factNodes + [node IN rawDomainNodes WHERE node.id IS NOT NULL] AS nodes,
				[edge IN rawEdges WHERE edge IS NOT NULL] AS edges
		`,
		params: {
			orgId,
			tediId,
			domainId,
			maxNodes,
			minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
			minEdgeStrength: MIN_EXPLANATION_EDGE_STRENGTH,
		},
	};
}

// ============================================================================
// Decision Trace — Causal chain visualization
// ============================================================================

/**
 * Get visualization data for a decision's full context:
 * the decision, its evidence (facts), preceding decisions, and outcomes.
 */
export function decisionTrace(decisionId: string, orgId: string) {
	return {
		query: `
			MATCH (d:Decision {id: $decisionId, orgId: $orgId})

			// Evidence facts
			OPTIONAL MATCH (d)-[:INFORMED_BY]->(evidence:Fact)
			WHERE evidence.orgId = d.orgId
				AND evidence.archivedAt IS NULL
				AND evidence.validTo IS NULL
				AND evidence.confidence >= $minFactConfidence
			// Preceding decisions
			OPTIONAL MATCH (d)-[:PRECEDED_BY]->(prev:Decision)
			WHERE prev.orgId = d.orgId
			// Downstream effects
			OPTIONAL MATCH (d)-[:CAUSED]->(effect)
			WHERE (effect:Decision AND effect.orgId = d.orgId)
				OR (effect:Fact
					AND effect.orgId = d.orgId
					AND effect.archivedAt IS NULL
					AND effect.validTo IS NULL
					AND effect.confidence >= $minFactConfidence)

			WITH d,
			collect(DISTINCT CASE WHEN evidence IS NULL THEN null ELSE {
				id: evidence.id,
				label: COALESCE(evidence.summary, left(evidence.content, 80)),
				type: 'fact',
				properties: {factType: evidence.factType, confidence: evidence.confidence}
			} END) AS rawEvidenceNodes,
			collect(DISTINCT CASE WHEN prev IS NULL THEN null ELSE {
				id: prev.id,
				label: prev.action,
				type: 'decision',
				properties: {
					category: prev.category,
					outcomeStatus: prev.outcomeStatus,
					confidence: prev.confidence
				}
			} END) AS rawPrevNodes,
			collect(DISTINCT CASE WHEN effect IS NULL THEN null ELSE {
				id: effect.id,
				label: COALESCE(effect.action, effect.summary, left(effect.content, 80)),
				type: CASE WHEN effect:Decision THEN 'decision' ELSE 'fact' END,
				properties: {}
			} END) AS rawEffectNodes

			// Build edges
			WITH d,
			[node IN rawEvidenceNodes WHERE node IS NOT NULL] AS evidenceNodes,
			[node IN rawPrevNodes WHERE node IS NOT NULL] AS prevNodes,
			[node IN rawEffectNodes WHERE node IS NOT NULL] AS effectNodes
			WITH d, evidenceNodes, prevNodes, effectNodes,
			[e IN evidenceNodes | {source: d.id, target: e.id, type: 'INFORMED_BY', properties: {}}] AS evidenceEdges,
			[p IN prevNodes | {source: d.id, target: p.id, type: 'PRECEDED_BY', properties: {}}] AS prevEdges,
			[ef IN effectNodes | {source: d.id, target: ef.id, type: 'CAUSED', properties: {}}] AS effectEdges

			RETURN [{
				id: d.id,
				label: d.action,
				type: 'decision',
				properties: {
					rationale: d.rationale,
					category: d.category,
					outcomeStatus: d.outcomeStatus,
					confidence: d.confidence,
					createdAt: d.createdAt
				}
			}] + evidenceNodes + prevNodes + effectNodes AS nodes,
			evidenceEdges + prevEdges + effectEdges AS edges
		`,
		params: {
			decisionId,
			orgId,
			minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
		},
	};
}

// ============================================================================
// Expertise Radar — Tedi's domain expertise as graph
// ============================================================================

/**
 * Visualize a tedi's expertise profile — domains, expertise levels,
 * and the facts that make up each domain's knowledge.
 */
export function expertiseRadar(tediId: string, orgId: string) {
	return {
		query: `
			MATCH (t:Tedi {id: $tediId, orgId: $orgId})-[e:EXPERT_IN]->(d:Domain {orgId: $orgId})
			OPTIONAL MATCH (f:Fact {tediId: $tediId, orgId: $orgId})-[:IN_DOMAIN]->(d)
			WHERE f.archivedAt IS NULL
				AND f.validTo IS NULL
				AND f.confidence >= $minFactConfidence
			WITH t, d, e, count(f) AS factCount

			WITH collect(DISTINCT {
				id: d.id,
				label: d.name,
				type: 'domain',
				properties: {
					expertiseLevel: e.level,
					factCount: factCount,
					avgConfidence: e.avgConfidence
				}
			}) AS domainNodes,
			{
				id: t.id,
				label: t.name,
				type: 'tedi',
				properties: {slug: t.slug}
			} AS tediNode

			WITH [tediNode] + domainNodes AS nodes,
			[d IN domainNodes | {
				source: tediNode.id,
				target: d.id,
				type: 'EXPERT_IN',
				properties: {level: d.properties.expertiseLevel}
			}] AS edges

			RETURN nodes, edges
		`,
		params: {
			tediId,
			orgId,
			minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
		},
	};
}

// ============================================================================
// Cross-Tedi Knowledge Flow
// ============================================================================

/**
 * Org-wide view — how knowledge flows between tedis.
 * Shared facts appear as bridge nodes connecting tedi knowledge islands.
 */
export function crossTediFlow(orgId: string) {
	return {
		query: `
			// Find tedis and their domains
			MATCH (tedi:Tedi {orgId: $orgId})
			OPTIONAL MATCH (tedi)-[e:EXPERT_IN]->(d:Domain {orgId: $orgId})

			WITH collect(DISTINCT {
				id: tedi.id,
				label: tedi.name,
				type: 'tedi',
				properties: {slug: tedi.slug}
			}) AS tediNodes,
			collect(DISTINCT {
				id: d.id,
				label: d.name,
				type: 'domain',
				properties: {}
			}) AS domainNodes,
			collect(DISTINCT {
				source: tedi.id,
				target: d.id,
				type: 'EXPERT_IN',
				properties: {level: e.level}
			}) AS rawExpertEdges

			// Find active shared/org-visible facts that bridge tedis.
			OPTIONAL MATCH (shared:Fact {orgId: $orgId})
			WHERE shared.visibility IN ['shared', 'org']
				AND shared.archivedAt IS NULL
				AND shared.validTo IS NULL
				AND shared.confidence >= $minFactConfidence
			OPTIONAL MATCH (shared)-[:OWNED_BY]->(owner:Tedi {orgId: $orgId})
			OPTIONAL MATCH (shared)-[:IN_DOMAIN]->(domain:Domain {orgId: $orgId})

			WITH tediNodes,
				[node IN domainNodes WHERE node.id IS NOT NULL] AS domainNodes,
				[edge IN rawExpertEdges WHERE edge.source IS NOT NULL AND edge.target IS NOT NULL] AS expertEdges,
				collect(DISTINCT CASE WHEN shared IS NULL THEN null ELSE {
					id: shared.id,
					label: COALESCE(shared.summary, left(shared.content, 80)),
					type: 'fact',
					properties: {
						factType: shared.factType,
						confidence: shared.confidence,
						visibility: shared.visibility,
						tediId: shared.tediId,
						domainId: shared.domainId
					}
				} END) AS rawFactNodes,
				collect(DISTINCT CASE WHEN owner IS NULL OR shared IS NULL THEN null ELSE {
					source: owner.id,
					target: shared.id,
					type: 'OWNS_FACT',
					properties: {}
				} END) AS rawOwnerEdges,
				collect(DISTINCT CASE WHEN domain IS NULL OR shared IS NULL THEN null ELSE {
					source: shared.id,
					target: domain.id,
					type: 'IN_DOMAIN',
					properties: {}
				} END) AS rawDomainEdges

			RETURN tediNodes + domainNodes + [node IN rawFactNodes WHERE node IS NOT NULL] AS nodes,
				expertEdges
					+ [edge IN rawOwnerEdges WHERE edge IS NOT NULL]
					+ [edge IN rawDomainEdges WHERE edge IS NOT NULL] AS edges
		`,
		params: {
			orgId,
			minFactConfidence: MIN_EXPLANATION_FACT_CONFIDENCE,
		},
	};
}
