/**
 * Decision graph Cypher: the `decision_edges` projection and its reads.
 *
 * Nodes are `(:DecisionNode {orgId, key: "<kind>:<id>", kind, id})`; edges
 * are `DG_<KIND>` relationships. Every pattern is rooted at an org-scoped
 * node and every variable-length walk stays inside DecisionNode.
 */

import {
	DECISION_GRAPH_EDGE_KINDS,
	type DecisionGraphEdgeKind,
} from "@tedix/api-contract/schemas/decision-graph";
import type { GraphDecisionEdge } from "../types";

/** Longest `blocks` / `same_as` walk a read follows. */
export const DECISION_GRAPH_WALK_HOPS = 4;

export function decisionNodeKey(kind: string, id: string): string {
	return `${kind}:${id}`;
}

/** Cypher cannot parameterize relationship types; only allowlisted kinds map. */
export function decisionGraphRelationshipType(
	kind: DecisionGraphEdgeKind,
): string {
	if (!DECISION_GRAPH_EDGE_KINDS.includes(kind)) {
		throw new Error(`Unknown decision graph edge kind: ${String(kind)}`);
	}
	return `DG_${kind.toUpperCase()}`;
}

function edgeRow(edge: GraphDecisionEdge) {
	return {
		id: edge.id,
		orgId: edge.orgId,
		kind: edge.kind,
		fromKey: decisionNodeKey(edge.fromKind, edge.fromId),
		fromKind: edge.fromKind,
		fromId: edge.fromId,
		toKey: decisionNodeKey(edge.toKind, edge.toId),
		toKind: edge.toKind,
		toId: edge.toId,
		confidence: edge.confidence ?? 1,
		note: edge.note ?? null,
		occurredAt: edge.occurredAt ?? null,
		projectionEpoch: edge.projectionEpoch ?? null,
	};
}

/** Groups edges by relationship type: at most one write per edge kind. */
export function groupDecisionGraphEdges(edges: readonly GraphDecisionEdge[]) {
	const groups = new Map<string, ReturnType<typeof edgeRow>[]>();
	for (const edge of edges) {
		const type = decisionGraphRelationshipType(edge.kind);
		const group = groups.get(type) ?? [];
		group.push(edgeRow(edge));
		groups.set(type, group);
	}
	return groups;
}

export function upsertDecisionGraphEdgesQuery(relationshipType: string) {
	return `
		UNWIND $edges AS row
		MERGE (source:DecisionNode {orgId: row.orgId, key: row.fromKey})
			ON CREATE SET source.kind = row.fromKind, source.id = row.fromId
		MERGE (target:DecisionNode {orgId: row.orgId, key: row.toKey})
			ON CREATE SET target.kind = row.toKind, target.id = row.toId
		MERGE (source)-[r:${relationshipType}]->(target)
		SET r.edgeId = row.id,
			r.orgId = row.orgId,
			r.kind = row.kind,
			r.confidence = row.confidence,
			r.note = row.note,
			r.occurredAt = row.occurredAt,
			r.projectionEpoch = coalesce(row.projectionEpoch, r.projectionEpoch)
		RETURN count(r) AS written
	`;
}

export function deleteDecisionGraphEdgesQuery(relationshipType: string) {
	return `
		UNWIND $edges AS row
		MATCH (source:DecisionNode {orgId: row.orgId, key: row.fromKey})
			-[r:${relationshipType}]->
			(target:DecisionNode {orgId: row.orgId, key: row.toKey})
		DELETE r
	`;
}

/** Removes endpoint nodes a delete left without any relationship. */
export const DELETE_ISOLATED_DECISION_NODES_QUERY = `
	UNWIND $nodes AS node
	MATCH (n:DecisionNode {orgId: node.orgId, key: node.key})
	WHERE NOT EXISTS { (n)--() }
	DELETE n
`;

/**
 * For each card: how many distinct nodes its blocks edges reach within
 * DECISION_GRAPH_WALK_HOPS, starting from the card, the Work it came from and
 * any extra subject keys (e.g. the card's canonical source Work).
 */
export function blocksReachQuery() {
	return {
		query: `
			UNWIND $cards AS card
			CALL {
				WITH card
				OPTIONAL MATCH (start:DecisionNode {orgId: $orgId})
				WHERE start.key IN card.keys
				OPTIONAL MATCH (start)-[:DG_CARD_FROM_WORK]->(work:DecisionNode {orgId: $orgId})
				WITH collect(DISTINCT start) + collect(DISTINCT work) AS starts
				UNWIND starts AS origin
				OPTIONAL MATCH (origin)-[:DG_BLOCKS*1..${DECISION_GRAPH_WALK_HOPS}]->(blocked:DecisionNode {orgId: $orgId})
				WHERE NOT blocked IN starts
				RETURN count(DISTINCT blocked) AS reach
			}
			RETURN card.id AS cardId, reach
		`,
	};
}

/**
 * Duplicate community per card: the `same_as` component around it (either
 * direction, bounded walk) plus other cards made from the same Work.
 */
export function duplicateCommunityQuery() {
	return {
		query: `
			UNWIND $cardIds AS cardId
			OPTIONAL MATCH (card:DecisionNode {orgId: $orgId, key: 'deck_card:' + cardId})
			CALL {
				WITH card
				OPTIONAL MATCH (card)-[:DG_SAME_AS*1..${DECISION_GRAPH_WALK_HOPS}]-(same:DecisionNode {orgId: $orgId, kind: 'deck_card'})
				RETURN collect(DISTINCT same.id) AS sameAs
			}
			CALL {
				WITH card
				OPTIONAL MATCH (card)-[:DG_CARD_FROM_WORK]->(:DecisionNode {orgId: $orgId})<-[:DG_CARD_FROM_WORK]-(sibling:DecisionNode {orgId: $orgId, kind: 'deck_card'})
				RETURN collect(DISTINCT sibling.id) AS siblings
			}
			RETURN cardId, [id IN sameAs + siblings WHERE id <> cardId] AS duplicates
		`,
	};
}
