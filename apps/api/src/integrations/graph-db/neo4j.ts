/**
 * Neo4j context-graph projection: the read client and the GraphWriter.
 *
 * Uses the Neo4j HTTP Query API (/db/{database}/query/v2) instead of
 * the Bolt protocol. This is REQUIRED for Cloudflare Workers because
 * Workers cannot open TCP sockets (which neo4j-driver's Bolt needs).
 *
 * The Query API is GA on all AuraDB tiers since 2024.
 * Reference: https://neo4j.com/docs/query-api/current/
 *
 * Usage:
 *   const { client, writer } = createNeo4jGraphClient({ uri, user, password });
 */

import {
	DELETE_ISOLATED_DECISION_NODES_QUERY,
	deleteDecisionGraphEdgesQuery,
	groupDecisionGraphEdges,
	upsertDecisionGraphEdgesQuery,
} from "./queries/decision-graph";
import { createHttpClient, runQuery, type HttpClient } from "./neo4j-http";
import {
	decisionBatchParams,
	parseEvidenceFactIds,
	toNumber,
	type ProjectionNodeLabel,
	type AdoptUnownedLegacyNodes,
} from "./neo4j-params";
import { createNeo4jReads } from "./neo4j-reads";
import { createNeo4jWrites } from "./neo4j-writes";
import { createNeo4jMaintenance } from "./neo4j-maintenance";
import type { GraphWriter } from "./sync";
import type {
	GraphDbConfig,
	GraphDecision,
	GraphEntity,
	GraphEntityResolution,
} from "./types";

export function createNeo4jGraphClient(config: GraphDbConfig) {
	const http = createHttpClient(config);
	async function adoptUnownedLegacyNodes(
		nodes: Array<{
			label: ProjectionNodeLabel;
			id: string | null | undefined;
			orgId: string;
		}>,
	): Promise<void> {
		const byLabel = new Map<
			ProjectionNodeLabel,
			Map<string, { id: string; orgId: string }>
		>();
		for (const node of nodes) {
			if (!node.id) continue;
			const group = byLabel.get(node.label) ?? new Map();
			const existing = group.get(node.id);
			if (existing && existing.orgId !== node.orgId) {
				throw new Error(
					`Neo4j legacy ${node.label} identity ${node.id} spans organizations`,
				);
			}
			group.set(node.id, {
				id: node.id,
				orgId: node.orgId,
			});
			byLabel.set(node.label, group);
		}
		for (const [label, group] of byLabel) {
			await runQuery(
				http,
				`
				UNWIND $nodes AS item
				OPTIONAL MATCH (legacy:${label} {id: item.id})
				WHERE legacy.orgId IS NULL
				SET legacy.orgId = item.orgId
				`,
				{ nodes: [...group.values()] },
			);
		}
	}
	const decisions = createDecisionWriter(
		http,
		adoptUnownedLegacyNodes,
		() => writer,
	);
	const client = { ...createNeo4jReads(http), ...createNeo4jMaintenance(http) };
	const writer = createNeo4jWrites(http, adoptUnownedLegacyNodes, decisions);
	return { client, writer };
}

/** The Neo4j read client; the only graph read implementation. */
export type GraphClient = ReturnType<typeof createNeo4jGraphClient>["client"];

function createDecisionWriter(
	http: HttpClient,
	adoptUnownedLegacyNodes: AdoptUnownedLegacyNodes,
	getWriter: () => GraphWriter,
) {
	async function rebuildDecisionPredecessors(
		decisions: GraphDecision[],
	): Promise<void> {
		if (decisions.length === 0) return;
		const items = decisions.map(decisionBatchParams);
		const records = await runQuery(
			http,
			`
			UNWIND $decisions AS item
			MATCH (d:Decision {orgId: item.orgId, id: item.id})
			OPTIONAL MATCH (d)-[stale:PRECEDED_BY]->()
			DELETE stale
			WITH DISTINCT d, item
			CALL {
				WITH d, item
				OPTIONAL MATCH (prev:Decision {
					orgId: item.orgId,
					tediId: item.tediId,
					category: item.category
				})
				WHERE prev.id <> item.id AND prev.createdAt < item.createdAt
				WITH prev
				ORDER BY prev.createdAt DESC, prev.id DESC
				LIMIT 1
				RETURN prev AS expected
			}
			FOREACH (_ IN CASE WHEN expected IS NOT NULL THEN [1] ELSE [] END |
				MERGE (d)-[precededBy:PRECEDED_BY]->(expected)
				SET precededBy.projectionEpoch =
						coalesce(item.projectionEpoch, precededBy.projectionEpoch),
					precededBy.projectionRepairEpoch =
						coalesce(item.projectionRepairEpoch, precededBy.projectionRepairEpoch))
			WITH d, expected
			OPTIONAL MATCH (d)-[:PRECEDED_BY]->(actual:Decision)
			WITH d, expected, collect(actual.id) AS actualIds
			RETURN count(d) AS written,
				sum(CASE
					WHEN expected IS NULL AND size(actualIds) = 0 THEN 1
					WHEN expected IS NOT NULL
						AND size(actualIds) = 1
						AND actualIds[0] = expected.id
						THEN 1
					ELSE 0
				END) AS verified
			`,
			{ decisions: items },
		);
		const written = toNumber(records[0]?.written);
		const verified = toNumber(records[0]?.verified);
		if (written !== decisions.length || verified !== decisions.length) {
			throw new Error(
				`Neo4j decision predecessor batch verification failed: expected ${decisions.length}, wrote ${written}, verified ${verified}`,
			);
		}
	}
	const writer: Pick<
		GraphWriter,
		| "upsertDecisionContexts"
		| "upsertDecisions"
		| "rebuildDecisionPredecessors"
		| "upsertDecision"
		| "upsertEntity"
		| "upsertEntityResolution"
		| "upsertDecisionGraphEdges"
		| "deleteDecision"
		| "deleteEntity"
		| "revokeEntityResolution"
		| "deleteDecisionGraphEdges"
	> = {
		async upsertDecisionContexts(decisions, options) {
			if (decisions.length === 0) return;
			if (
				options?.requireProjectionEpoch &&
				decisions.some(
					(decision) =>
						typeof decision.projectionEpoch !== "string" ||
						decision.projectionEpoch.length === 0,
				)
			) {
				throw new Error(
					"Neo4j baseline decision context requires a projection epoch",
				);
			}
			if (
				options?.requireRepairEpoch &&
				decisions.some(
					(decision) =>
						typeof decision.projectionRepairEpoch !== "string" ||
						decision.projectionRepairEpoch.length === 0,
				)
			) {
				throw new Error(
					"Neo4j baseline decision context requires a repair epoch",
				);
			}
			const items = decisions.map(decisionBatchParams);
			await adoptUnownedLegacyNodes(
				items.flatMap((decision) => [
					{
						label: "Decision" as const,
						id: decision.id,
						orgId: decision.orgId,
					},
					{
						label: "Tedi" as const,
						id: decision.tediId,
						orgId: decision.orgId,
					},
					{
						label: "Outcome" as const,
						id: decision.outcomeId,
						orgId: decision.orgId,
					},
					{
						label: "Objective" as const,
						id: decision.objectiveId,
						orgId: decision.orgId,
					},
					{
						label: "ApprovalRequest" as const,
						id: decision.approvalRequestId,
						orgId: decision.orgId,
					},
				]),
			);
			const records = await runQuery(
				http,
				`
				UNWIND $decisions AS item
				MERGE (d:Decision {id: item.id, orgId: item.orgId})
				SET d:Episode,
					d.tediId = item.tediId,
					d.action = item.action,
					d.rationale = item.rationale,
					d.category = item.category,
					d.confidence = item.confidence,
					d.outcomeStatus = item.outcomeStatus,
					d.objectiveId = item.objectiveId,
					d.approvalRequestId = item.approvalRequestId,
					d.createdAt = item.createdAt,
					d.completedAt = item.completedAt,
					d.projectionEpoch =
						coalesce(item.projectionEpoch, d.projectionEpoch),
					d.projectionRepairEpoch =
						coalesce(item.projectionRepairEpoch, d.projectionRepairEpoch)
				WITH d, item
				OPTIONAL MATCH (d)-[managed:DECIDED_BY|COMPLETED_AS|SERVES_OBJECTIVE|GATED_BY|INFORMED_BY|USED|IGNORED]->()
				DELETE managed
				WITH DISTINCT d, item
				MERGE (t:Tedi {id: item.tediId, orgId: item.orgId})
				SET t.projectionEpoch =
						coalesce(item.projectionEpoch, t.projectionEpoch),
					t.projectionRepairEpoch =
						coalesce(item.projectionRepairEpoch, t.projectionRepairEpoch)
				MERGE (d)-[decidedBy:DECIDED_BY]->(t)
				SET decidedBy.projectionEpoch =
						coalesce(item.projectionEpoch, decidedBy.projectionEpoch),
					decidedBy.projectionRepairEpoch =
						coalesce(item.projectionRepairEpoch, decidedBy.projectionRepairEpoch)
				WITH d, item
				MERGE (o:Outcome {id: item.outcomeId, orgId: item.orgId})
				SET o.tediId = item.tediId,
					o.decisionId = item.id,
					o.status = item.outcomeStatus,
					o.completedAt = item.completedAt,
					o.updatedAt = datetime(),
					o.projectionEpoch =
						coalesce(item.projectionEpoch, o.projectionEpoch),
					o.projectionRepairEpoch =
						coalesce(item.projectionRepairEpoch, o.projectionRepairEpoch)
				MERGE (d)-[completedAs:COMPLETED_AS]->(o)
				SET completedAs.projectionEpoch =
						coalesce(item.projectionEpoch, completedAs.projectionEpoch),
					completedAs.projectionRepairEpoch =
						coalesce(item.projectionRepairEpoch, completedAs.projectionRepairEpoch)
				WITH d, item
				FOREACH (_ IN CASE WHEN item.objectiveId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (objective:Objective {
						id: item.objectiveId,
						orgId: item.orgId
					})
					SET objective.projectionEpoch =
							coalesce(item.projectionEpoch, objective.projectionEpoch),
						objective.projectionRepairEpoch =
							coalesce(item.projectionRepairEpoch, objective.projectionRepairEpoch)
					MERGE (d)-[servesObjective:SERVES_OBJECTIVE]->(objective)
					SET servesObjective.projectionEpoch =
							coalesce(item.projectionEpoch, servesObjective.projectionEpoch),
						servesObjective.projectionRepairEpoch =
							coalesce(item.projectionRepairEpoch, servesObjective.projectionRepairEpoch))
				FOREACH (_ IN CASE WHEN item.approvalRequestId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (approval:ApprovalRequest {
						id: item.approvalRequestId,
						orgId: item.orgId
					})
					SET approval.tediId = item.tediId,
						approval.projectionEpoch =
							coalesce(item.projectionEpoch, approval.projectionEpoch),
						approval.projectionRepairEpoch =
							coalesce(item.projectionRepairEpoch, approval.projectionRepairEpoch)
					MERGE (d)-[gatedBy:GATED_BY]->(approval)
					SET gatedBy.projectionEpoch =
							coalesce(item.projectionEpoch, gatedBy.projectionEpoch),
						gatedBy.projectionRepairEpoch =
							coalesce(item.projectionRepairEpoch, gatedBy.projectionRepairEpoch))
				WITH d, item
				CALL {
					WITH d, item
					UNWIND item.evidenceFactIds AS factId
					MATCH (f:Fact {id: factId, orgId: item.orgId})
					MERGE (d)-[informedBy:INFORMED_BY]->(f)
					SET informedBy.projectionEpoch =
							coalesce(item.projectionEpoch, informedBy.projectionEpoch),
						informedBy.projectionRepairEpoch =
							coalesce(item.projectionRepairEpoch, informedBy.projectionRepairEpoch)
					RETURN count(*) AS informedCount
				}
				RETURN count(DISTINCT d) AS written
				`,
				{ decisions: items },
			);
			const written = toNumber(records[0]?.written);
			if (written !== decisions.length) {
				throw new Error(
					`Neo4j decision batch write failed: expected ${decisions.length}, wrote ${written}`,
				);
			}
			const verification = await runQuery(
				http,
				`
				UNWIND $decisions AS item
				MATCH (d:Decision {id: item.id, orgId: item.orgId})
				MATCH (d)-[decidedBy:DECIDED_BY]->(t:Tedi {
					id: item.tediId,
					orgId: item.orgId
				})
				MATCH (d)-[completedAs:COMPLETED_AS]->(o:Outcome {
					id: item.outcomeId,
					orgId: item.orgId
				})
				RETURN
					sum(CASE
						WHEN d:Episode
							AND o.decisionId = item.id
							AND o.tediId = item.tediId
							AND o.status = item.outcomeStatus
							AND (
								item.projectionEpoch IS NULL
								OR (
									d.projectionEpoch = item.projectionEpoch
									AND t.projectionEpoch = item.projectionEpoch
									AND o.projectionEpoch = item.projectionEpoch
									AND decidedBy.projectionEpoch = item.projectionEpoch
									AND completedAs.projectionEpoch = item.projectionEpoch
								)
							)
							AND (
								item.projectionRepairEpoch IS NULL
								OR (
									d.projectionRepairEpoch = item.projectionRepairEpoch
									AND t.projectionRepairEpoch = item.projectionRepairEpoch
									AND o.projectionRepairEpoch =
										item.projectionRepairEpoch
									AND decidedBy.projectionRepairEpoch =
										item.projectionRepairEpoch
									AND completedAs.projectionRepairEpoch =
										item.projectionRepairEpoch
								)
							)
							THEN 1
						ELSE 0
					END) AS verified
				`,
				{ decisions: items },
			);
			const verified = toNumber(verification[0]?.verified);
			if (verified !== decisions.length) {
				throw new Error(
					`Neo4j decision batch verification failed: expected ${decisions.length}, wrote ${written}, verified ${verified}`,
				);
			}
		},

		async upsertDecisions(decisions) {
			await getWriter().upsertDecisionContexts?.(decisions);
			await rebuildDecisionPredecessors(decisions);
		},

		rebuildDecisionPredecessors,

		async upsertDecision(decision) {
			const outcomeId = `${decision.id}:outcome`;

			await adoptUnownedLegacyNodes([
				{ label: "Decision", id: decision.id, orgId: decision.orgId },
				{ label: "Tedi", id: decision.tediId, orgId: decision.orgId },
				{ label: "Outcome", id: outcomeId, orgId: decision.orgId },
				{
					label: "Objective",
					id: decision.objectiveId,
					orgId: decision.orgId,
				},
				{
					label: "ApprovalRequest",
					id: decision.approvalRequestId,
					orgId: decision.orgId,
				},
			]);
			await runQuery(
				http,
				`
				MERGE (d:Decision {id: $id, orgId: $orgId})
				SET d:Episode,
					d.tediId = $tediId,
					d.action = $action,
					d.rationale = $rationale,
					d.category = $category,
					d.confidence = $confidence,
					d.outcomeStatus = $outcomeStatus,
					d.objectiveId = $objectiveId,
					d.approvalRequestId = $approvalRequestId,
					d.createdAt = $createdAt,
					d.completedAt = $completedAt,
					d.projectionEpoch = coalesce($projectionEpoch, d.projectionEpoch),
					d.projectionRepairEpoch = coalesce($projectionRepairEpoch, d.projectionRepairEpoch)
				WITH d
				OPTIONAL MATCH (d)-[managed:DECIDED_BY|COMPLETED_AS|SERVES_OBJECTIVE|GATED_BY|INFORMED_BY|USED|IGNORED]->()
				DELETE managed
				WITH DISTINCT d
				// Link to tedi
				MERGE (t:Tedi {id: $tediId, orgId: $orgId})
				SET t.projectionEpoch = coalesce($projectionEpoch, t.projectionEpoch),
					t.projectionRepairEpoch = coalesce($projectionRepairEpoch, t.projectionRepairEpoch)
				MERGE (d)-[decidedBy:DECIDED_BY]->(t)
				SET decidedBy.projectionEpoch = coalesce($projectionEpoch, decidedBy.projectionEpoch),
					decidedBy.projectionRepairEpoch = coalesce($projectionRepairEpoch, decidedBy.projectionRepairEpoch)
				WITH d
				// Decision episodes always carry an outcome node, even while pending.
				MERGE (o:Outcome {id: $outcomeId, orgId: $orgId})
				SET o.tediId = $tediId,
					o.decisionId = $id,
					o.status = $outcomeStatus,
					o.completedAt = $completedAt,
					o.updatedAt = datetime(),
					o.projectionEpoch = coalesce($projectionEpoch, o.projectionEpoch),
					o.projectionRepairEpoch = coalesce($projectionRepairEpoch, o.projectionRepairEpoch)
				MERGE (d)-[completedAs:COMPLETED_AS]->(o)
				SET completedAs.projectionEpoch = coalesce($projectionEpoch, completedAs.projectionEpoch),
					completedAs.projectionRepairEpoch = coalesce($projectionRepairEpoch, completedAs.projectionRepairEpoch)
				WITH d
				// Link objective and approval context when present.
				FOREACH (_ IN CASE WHEN $objectiveId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (obj:Objective {id: $objectiveId, orgId: $orgId})
					SET obj.projectionEpoch = coalesce($projectionEpoch, obj.projectionEpoch),
						obj.projectionRepairEpoch = coalesce($projectionRepairEpoch, obj.projectionRepairEpoch)
					MERGE (d)-[servesObjective:SERVES_OBJECTIVE]->(obj)
					SET servesObjective.projectionEpoch = coalesce($projectionEpoch, servesObjective.projectionEpoch),
						servesObjective.projectionRepairEpoch = coalesce($projectionRepairEpoch, servesObjective.projectionRepairEpoch))
				FOREACH (_ IN CASE WHEN $approvalRequestId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (approval:ApprovalRequest {id: $approvalRequestId, orgId: $orgId})
					SET approval.tediId = $tediId,
						approval.projectionEpoch = coalesce($projectionEpoch, approval.projectionEpoch),
						approval.projectionRepairEpoch = coalesce($projectionRepairEpoch, approval.projectionRepairEpoch)
					MERGE (d)-[gatedBy:GATED_BY]->(approval)
					SET gatedBy.projectionEpoch = coalesce($projectionEpoch, gatedBy.projectionEpoch),
						gatedBy.projectionRepairEpoch = coalesce($projectionRepairEpoch, gatedBy.projectionRepairEpoch))
				// Parse evidence and link to facts
				WITH d
				CALL {
					WITH d
					UNWIND $evidenceFactIds AS factId
					MATCH (f:Fact {id: factId, orgId: $orgId})
					MERGE (d)-[informedBy:INFORMED_BY]->(f)
					SET informedBy.projectionEpoch = coalesce($projectionEpoch, informedBy.projectionEpoch),
						informedBy.projectionRepairEpoch = coalesce($projectionRepairEpoch, informedBy.projectionRepairEpoch)
					RETURN count(*) AS informedCount
				}
				RETURN d.id AS decisionId
				`,
				{
					id: decision.id,
					tediId: decision.tediId,
					orgId: decision.orgId,
					action: decision.action,
					rationale: decision.rationale,
					category: decision.category,
					confidence: decision.confidence,
					outcomeStatus: decision.outcomeStatus,
					objectiveId: decision.objectiveId ?? null,
					approvalRequestId: decision.approvalRequestId ?? null,
					createdAt: decision.createdAt,
					completedAt: decision.completedAt,
					outcomeId,
					evidenceFactIds: parseEvidenceFactIds(decision.evidence),
					projectionEpoch: decision.projectionEpoch ?? null,
					projectionRepairEpoch: decision.projectionRepairEpoch ?? null,
				},
			);

			// Link to preceding decision (same tedi + category)
			await runQuery(
				http,
				`
				MATCH (d:Decision {id: $id, orgId: $orgId})
				OPTIONAL MATCH (d)-[managed:PRECEDED_BY]->()
				DELETE managed
				WITH DISTINCT d
				OPTIONAL MATCH (prev:Decision {tediId: $tediId, category: $category, orgId: $orgId})
				WHERE prev.id <> $id AND prev.createdAt < $createdAt
				WITH d, prev ORDER BY prev.createdAt DESC LIMIT 1
				FOREACH (_ IN CASE WHEN prev IS NOT NULL THEN [1] ELSE [] END |
					MERGE (d)-[precededBy:PRECEDED_BY]->(prev)
					SET precededBy.projectionEpoch = coalesce($projectionEpoch, precededBy.projectionEpoch),
						precededBy.projectionRepairEpoch = coalesce($projectionRepairEpoch, precededBy.projectionRepairEpoch))
				`,
				{
					id: decision.id,
					orgId: decision.orgId,
					tediId: decision.tediId,
					category: decision.category,
					createdAt: decision.createdAt,
					projectionEpoch: decision.projectionEpoch ?? null,
					projectionRepairEpoch: decision.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertEntity(entity: GraphEntity) {
			await runQuery(
				http,
				`
				MERGE (e:Entity {id: $id, orgId: $orgId})
				SET e.entityType = $entityType,
					e.displayName = $displayName,
					e.normalizedName = $normalizedName,
					e.status = $status,
					e.mergedIntoEntityId = $mergedIntoEntityId,
					e.version = $version,
					e.updatedAt = $updatedAt,
					e.projectionEpoch = coalesce($projectionEpoch, e.projectionEpoch),
					e.projectionRepairEpoch = coalesce($projectionRepairEpoch, e.projectionRepairEpoch)
				WITH e
				OPTIONAL MATCH (e)-[managed:MERGED_INTO]->()
				DELETE managed
				WITH DISTINCT e
				FOREACH (_ IN CASE WHEN $mergedIntoEntityId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (target:Entity {id: $mergedIntoEntityId, orgId: $orgId})
					SET target.projectionEpoch = coalesce($projectionEpoch, target.projectionEpoch),
						target.projectionRepairEpoch = coalesce($projectionRepairEpoch, target.projectionRepairEpoch)
					MERGE (e)-[mergedInto:MERGED_INTO]->(target)
					SET mergedInto.projectionEpoch = coalesce($projectionEpoch, mergedInto.projectionEpoch),
						mergedInto.projectionRepairEpoch = coalesce($projectionRepairEpoch, mergedInto.projectionRepairEpoch))
				`,
				{
					id: entity.id,
					orgId: entity.orgId,
					entityType: entity.entityType,
					displayName: entity.displayName,
					normalizedName: entity.normalizedName,
					status: entity.status,
					mergedIntoEntityId: entity.mergedIntoEntityId,
					version: entity.version,
					updatedAt: entity.updatedAt,
					projectionEpoch: entity.projectionEpoch ?? null,
					projectionRepairEpoch: entity.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertEntityResolution(resolution: GraphEntityResolution) {
			await runQuery(
				http,
				`
				MERGE (r:EntityResolution {id: $id, orgId: $orgId})
				SET r.mentionId = $mentionId,
					r.factId = $factId,
					r.entityId = $entityId,
					r.decisionId = $decisionId,
					r.confidence = $confidence,
					r.validFrom = $validFrom,
					r.validTo = $validTo,
					r.status = $status,
					r.projectionEpoch = coalesce($projectionEpoch, r.projectionEpoch),
					r.projectionRepairEpoch = coalesce($projectionRepairEpoch, r.projectionRepairEpoch)
				WITH r
				OPTIONAL MATCH (r)-[managed:RESOLVES_TO|SUPPORTED_BY|DECIDED_IN]->()
				DELETE managed
				WITH DISTINCT r
				MATCH (e:Entity {id: $entityId, orgId: $orgId})
				SET e.projectionEpoch = coalesce($projectionEpoch, e.projectionEpoch),
					e.projectionRepairEpoch = coalesce($projectionRepairEpoch, e.projectionRepairEpoch)
				MERGE (r)-[resolvesTo:RESOLVES_TO]->(e)
				SET resolvesTo.projectionEpoch = coalesce($projectionEpoch, resolvesTo.projectionEpoch),
					resolvesTo.projectionRepairEpoch = coalesce($projectionRepairEpoch, resolvesTo.projectionRepairEpoch)
				WITH r
				FOREACH (_ IN CASE WHEN $factId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (f:Fact {id: $factId, orgId: $orgId})
					SET f.projectionEpoch = coalesce($projectionEpoch, f.projectionEpoch),
						f.projectionRepairEpoch = coalesce($projectionRepairEpoch, f.projectionRepairEpoch)
					MERGE (r)-[supportedBy:SUPPORTED_BY]->(f)
					SET supportedBy.projectionEpoch = coalesce($projectionEpoch, supportedBy.projectionEpoch),
						supportedBy.projectionRepairEpoch = coalesce($projectionRepairEpoch, supportedBy.projectionRepairEpoch))
				FOREACH (_ IN CASE WHEN $decisionId IS NOT NULL THEN [1] ELSE [] END |
					MERGE (d:EntityResolutionDecision {id: $decisionId, orgId: $orgId})
					SET d.projectionEpoch = coalesce($projectionEpoch, d.projectionEpoch),
						d.projectionRepairEpoch = coalesce($projectionRepairEpoch, d.projectionRepairEpoch)
					MERGE (r)-[decidedIn:DECIDED_IN]->(d)
					SET decidedIn.projectionEpoch = coalesce($projectionEpoch, decidedIn.projectionEpoch),
						decidedIn.projectionRepairEpoch = coalesce($projectionRepairEpoch, decidedIn.projectionRepairEpoch))
				`,
				{
					id: resolution.id,
					orgId: resolution.orgId,
					mentionId: resolution.mentionId,
					factId: resolution.factId,
					entityId: resolution.entityId,
					decisionId: resolution.decisionId,
					confidence: resolution.confidence,
					validFrom: resolution.validFrom,
					validTo: resolution.validTo,
					status: resolution.status,
					projectionEpoch: resolution.projectionEpoch ?? null,
					projectionRepairEpoch: resolution.projectionRepairEpoch ?? null,
				},
			);
		},

		async upsertDecisionGraphEdges(edges) {
			for (const [type, rows] of groupDecisionGraphEdges(edges)) {
				const records = await runQuery(
					http,
					upsertDecisionGraphEdgesQuery(type),
					{ edges: rows },
				);
				const written = toNumber(records[0]?.written);
				if (written !== rows.length) {
					throw new Error(
						`Neo4j decision graph ${type} batch verification failed: expected ${rows.length}, wrote ${written}`,
					);
				}
			}
		},

		async deleteDecisionGraphEdges(edges) {
			const nodes = new Map<string, { orgId: string; key: string }>();
			for (const [type, rows] of groupDecisionGraphEdges(edges)) {
				await runQuery(http, deleteDecisionGraphEdgesQuery(type), {
					edges: rows,
				});
				for (const row of rows) {
					for (const key of [row.fromKey, row.toKey]) {
						nodes.set(`${row.orgId}\u0000${key}`, { orgId: row.orgId, key });
					}
				}
			}
			if (nodes.size > 0) {
				await runQuery(http, DELETE_ISOLATED_DECISION_NODES_QUERY, {
					nodes: [...nodes.values()],
				});
			}
		},
		async deleteDecision(id, orgId) {
			await runQuery(
				http,
				"MATCH (d:Decision {id: $id, orgId: $orgId}) DETACH DELETE d",
				{ id, orgId },
			);
		},

		async deleteEntity(id, orgId) {
			await runQuery(
				http,
				"MATCH (e:Entity {id: $id, orgId: $orgId}) DETACH DELETE e",
				{ id, orgId },
			);
		},

		async revokeEntityResolution(id, orgId, validTo) {
			await runQuery(
				http,
				`
				MATCH (r:EntityResolution {id: $id, orgId: $orgId})
				SET r.status = 'revoked',
					r.validTo = $validTo,
					r.revokedAt = $validTo
				`,
				{ id, orgId, validTo },
			);
		},
	};
	return writer;
}
