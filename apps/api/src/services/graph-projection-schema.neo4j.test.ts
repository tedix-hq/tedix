import {
	createNeo4jGraphClient,
	runCypherWithParams,
} from "../integrations/graph-db/neo4j";
import { processSyncBatch } from "../integrations/graph-db/sync";
import type { SyncEvent } from "../integrations/graph-db/types";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../integrations/graph-db/client", async () => {
	const graphDb = await vi.importActual<
		typeof import("../integrations/graph-db/neo4j")
	>("../integrations/graph-db/neo4j");
	return {
		runCypherWithParams: (
			env: CloudflareEnv,
			cypher: string,
			params: Record<string, unknown>,
		) =>
			graphDb.runCypherWithParams(
				{
					uri: env.GRAPH_DB_URI!,
					user: env.GRAPH_DB_USER!,
					password: env.GRAPH_DB_PASSWORD!,
				},
				cypher,
				params,
			),
	};
});

import {
	DUPLICATE_MANAGED_RELATIONSHIP_CLEANUP_QUERY,
	GRAPH_PROJECTION_CLEANUP_BATCH_SIZE,
	MANAGED_RELATIONSHIP_TYPES,
	sweepGraphProjectionEpoch,
} from "./graph-projection-schema";

type GraphConfig = {
	uri: string;
	user: string;
	password: string;
};

type ProfilePlanNode = {
	operatorType?: unknown;
	arguments?: Record<string, unknown>;
	children?: unknown;
};

type QueryApiResponse = {
	data?: {
		fields?: unknown;
		values?: unknown;
	};
	errors?: unknown;
	profiledQueryPlan?: unknown;
};

const LIVE_TEST_ENABLED = process.env.GRAPH_PROJECTION_NEO4J_LIVE_TEST === "1";
const PAIR_COUNT = 50;
const RELATIONSHIPS_PER_PAIR = 101;
const EXPECTED_BASE_DUPLICATES = PAIR_COUNT * (RELATIONSHIPS_PER_PAIR - 1);
const EXPECTED_VARIANT_DUPLICATES = 4;
const LIVE_REGRESSION_HARNESS = "graph-projection-duplicate-cleanup-v1";

function requireGraphConfig(): GraphConfig {
	const uri = process.env.GRAPH_DB_URI;
	const user = process.env.GRAPH_DB_USER;
	const password = process.env.GRAPH_DB_PASSWORD;
	if (!uri || !user || !password) {
		throw new Error(
			"Live Neo4j regression requires GRAPH_DB_URI, GRAPH_DB_USER, and GRAPH_DB_PASSWORD",
		);
	}
	return { uri, user, password };
}

function queryApiEndpoint(uri: string): string {
	const httpUri = uri
		.replace(/^neo4j\+s:\/\//, "https://")
		.replace(/^neo4j:\/\//, "http://");
	const endpoint = new URL(httpUri);
	endpoint.pathname = "/db/neo4j/query/v2";
	endpoint.search = "";
	return endpoint.toString();
}

function asPlanNode(value: unknown): ProfilePlanNode {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Neo4j Query API returned a malformed profile plan");
	}
	return value as ProfilePlanNode;
}

function planChildren(node: ProfilePlanNode): ProfilePlanNode[] {
	if (!Array.isArray(node.children)) return [];
	return node.children.map(asPlanNode);
}

function findPlanNode(
	node: ProfilePlanNode,
	predicate: (candidate: ProfilePlanNode) => boolean,
): ProfilePlanNode | null {
	if (predicate(node)) return node;
	for (const child of planChildren(node)) {
		const match = findPlanNode(child, predicate);
		if (match) return match;
	}
	return null;
}

function collectOperatorTypes(node: ProfilePlanNode): string[] {
	return [
		String(node.operatorType ?? ""),
		...planChildren(node).flatMap(collectOperatorTypes),
	];
}

async function profileCleanupBatch(
	config: GraphConfig,
	organizationId: string,
): Promise<{ removed: number; plan: ProfilePlanNode }> {
	const response = await fetch(queryApiEndpoint(config.uri), {
		method: "POST",
		headers: {
			Authorization: `Basic ${btoa(`${config.user}:${config.password}`)}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			statement: `PROFILE ${DUPLICATE_MANAGED_RELATIONSHIP_CLEANUP_QUERY}`,
			parameters: {
				orgId: organizationId,
				managedRelationshipTypes: [...MANAGED_RELATIONSHIP_TYPES],
				batchSize: GRAPH_PROJECTION_CLEANUP_BATCH_SIZE,
			},
		}),
	});
	const body = (await response.json()) as QueryApiResponse;
	if (!response.ok || (Array.isArray(body.errors) && body.errors.length > 0)) {
		throw new Error(
			`Neo4j profile failed: HTTP ${response.status} ${JSON.stringify(body.errors ?? null)}`,
		);
	}
	const values = body.data?.values;
	if (
		!Array.isArray(values) ||
		!Array.isArray(values[0]) ||
		typeof values[0][0] !== "number"
	) {
		throw new Error("Neo4j profile returned malformed cleanup counts");
	}
	return {
		removed: values[0][0],
		plan: asPlanNode(body.profiledQueryPlan),
	};
}

describe.runIf(LIVE_TEST_ENABLED)(
	"graph projection duplicate cleanup against real Neo4j",
	() => {
		it("preserves a current-epoch post-repair cohort during epoch sweep", async () => {
			const config = requireGraphConfig();
			const organizationId = crypto.randomUUID();
			const projectionEpoch = crypto.randomUUID();
			const staleProjectionEpoch = crypto.randomUUID();
			const env = {
				GRAPH_DB_URI: config.uri,
				GRAPH_DB_USER: config.user,
				GRAPH_DB_PASSWORD: config.password,
			} as CloudflareEnv;
			const { writer } = createNeo4jGraphClient(config);
			const timestamp = Date.parse("2026-07-28T00:00:00.000Z");
			const fact = (id: string): SyncEvent => ({
				op: "upsert_fact",
				id,
				orgId: organizationId,
				timestamp,
				payload: {
					id,
					orgId: organizationId,
					tediId: null,
					domainId: null,
					content: `Post-repair ${id}`,
					summary: null,
					factType: "technical",
					confidence: 0.9,
					validTo: null,
					archivedAt: null,
					priority: null,
					visibility: null,
					accessCount: 0,
					usageCount: 0,
					createdAt: new Date(timestamp).toISOString(),
					updatedAt: new Date(timestamp).toISOString(),
					projectionEpoch,
				},
			});
			const cohort = [
				fact("post-repair-source"),
				fact("post-repair-target"),
				{
					op: "upsert_decision",
					id: "post-repair-decision",
					orgId: organizationId,
					timestamp,
					payload: {
						id: "post-repair-decision",
						orgId: organizationId,
						tediId: "post-repair-tedi",
						action: "retain current projection generation",
						rationale: "The direct drain supplied the active epoch",
						category: "projection",
						confidence: 0.9,
						outcomeStatus: "completed",
						evidence: "{}",
						objectiveId: null,
						approvalRequestId: null,
						createdAt: new Date(timestamp).toISOString(),
						completedAt: new Date(timestamp + 1_000).toISOString(),
						projectionEpoch,
					},
				},
				{
					op: "upsert_edge",
					id: "post-repair-edge",
					orgId: organizationId,
					timestamp,
					payload: {
						id: "post-repair-edge",
						orgId: organizationId,
						sourceFactId: "post-repair-source",
						targetFactId: "post-repair-target",
						relationType: "related_to",
						strength: 0.8,
						context: "Current epoch",
						updatedAt: new Date(timestamp).toISOString(),
						projectionEpoch,
					},
				},
			] satisfies SyncEvent[];

			try {
				const written = await processSyncBatch(cohort, writer, {
					stopOnError: true,
				});
				expect(written).toMatchObject({ processed: 4, errors: 0 });
				await runCypherWithParams(
					config,
					`CREATE (:Fact {
					   orgId: $orgId,
					   id: "stale-fact",
					   projectionEpoch: $staleProjectionEpoch
					 })`,
					{ orgId: organizationId, staleProjectionEpoch },
				);

				const swept = await sweepGraphProjectionEpoch({
					env,
					organizationId,
					projectionEpoch,
				});
				expect(swept.nodesRemoved).toBe(1);

				const [remaining] = await runCypherWithParams(
					config,
					`MATCH (fact:Fact {orgId: $orgId})
					 OPTIONAL MATCH (source:Fact {
					   orgId: $orgId,
					   id: "post-repair-source"
					 })-[relationship:RELATED_TO]->(target:Fact {
					   orgId: $orgId,
					   id: "post-repair-target"
					 })
					 OPTIONAL MATCH (decision:Decision {
					   orgId: $orgId,
					   id: "post-repair-decision"
					 })-[owner:DECIDED_BY]->(:Tedi {orgId: $orgId})
					 OPTIONAL MATCH (decision)-[completion:COMPLETED_AS]->(outcome:Outcome {
					   orgId: $orgId
					 })
					 RETURN count(DISTINCT fact) AS factCount,
					   count(DISTINCT relationship) AS relationshipCount,
					   count(DISTINCT decision) AS decisionCount,
					   count(DISTINCT outcome) AS outcomeCount,
					   count(DISTINCT owner) AS ownerCount,
					   count(DISTINCT completion) AS completionCount,
					   collect(DISTINCT fact.projectionEpoch) AS projectionEpochs`,
					{ orgId: organizationId },
				);
				expect(Number(remaining?.factCount)).toBe(2);
				expect(Number(remaining?.relationshipCount)).toBe(1);
				expect(Number(remaining?.decisionCount)).toBe(1);
				expect(Number(remaining?.outcomeCount)).toBe(1);
				expect(Number(remaining?.ownerCount)).toBe(1);
				expect(Number(remaining?.completionCount)).toBe(1);
				expect(remaining?.projectionEpochs).toEqual([projectionEpoch]);
			} finally {
				await runCypherWithParams(
					config,
					"MATCH (node {orgId: $orgId}) DETACH DELETE node",
					{
						orgId: organizationId,
					},
				);
			}
		}, 60_000);

		it("bounds eager discovery state and converges a multi-batch duplicate cohort", async () => {
			const config = requireGraphConfig();
			const organizationId = crypto.randomUUID();
			const sentinelOrganizationId = crypto.randomUUID();
			const projectionEpoch = crypto.randomUUID();
			const liveRegressionRunId = crypto.randomUUID();
			const env = {
				GRAPH_DB_URI: config.uri,
				GRAPH_DB_USER: config.user,
				GRAPH_DB_PASSWORD: config.password,
			} as CloudflareEnv;
			const pairs = Array.from({ length: PAIR_COUNT }, (_, index) => ({
				sourceId: `source-${index}`,
				targetId: `target-${index}`,
			}));
			const relationships = pairs.flatMap((pair) =>
				Array.from({ length: RELATIONSHIPS_PER_PAIR }, () => pair),
			);

			try {
				await runCypherWithParams(
					config,
					`UNWIND $pairs AS pair
						 CREATE (:Fact {
						   orgId: $orgId,
						   id: pair.sourceId,
						   projectionEpoch: $projectionEpoch,
						   liveRegressionHarness: $liveRegressionHarness,
						   liveRegressionRunId: $liveRegressionRunId
						 })
						 CREATE (:Fact {
						   orgId: $orgId,
						   id: pair.targetId,
						   projectionEpoch: $projectionEpoch,
						   liveRegressionHarness: $liveRegressionHarness,
						   liveRegressionRunId: $liveRegressionRunId
						 })`,
					{
						pairs,
						orgId: organizationId,
						projectionEpoch,
						liveRegressionHarness: LIVE_REGRESSION_HARNESS,
						liveRegressionRunId,
					},
				);
				for (
					let offset = 0;
					offset < relationships.length;
					offset += GRAPH_PROJECTION_CLEANUP_BATCH_SIZE
				) {
					await runCypherWithParams(
						config,
						`UNWIND $relationships AS relationship
							 MATCH (source:Fact {
							   orgId: $orgId,
							   id: relationship.sourceId
							 })
							 MATCH (target:Fact {
							   orgId: $orgId,
							   id: relationship.targetId
							 })
							 CREATE (source)-[:RELATED_TO {
							   projectionEpoch: $projectionEpoch
							 }]->(target)`,
						{
							relationships: relationships.slice(
								offset,
								offset + GRAPH_PROJECTION_CLEANUP_BATCH_SIZE,
							),
							orgId: organizationId,
							projectionEpoch,
						},
					);
				}
				await runCypherWithParams(
					config,
					`MATCH (source:Fact {orgId: $orgId, id: "source-0"})
						 MATCH (target:Fact {orgId: $orgId, id: "target-0"})
						 UNWIND range(1, 3) AS ignored
						 CREATE (source)-[:IN_DOMAIN {
						   projectionEpoch: $projectionEpoch
						 }]->(target)
						 CREATE (target)-[:RELATED_TO {
						   projectionEpoch: $projectionEpoch
						 }]->(source)`,
					{ orgId: organizationId, projectionEpoch },
				);
				await runCypherWithParams(
					config,
					`CREATE (source:Fact {
						   orgId: $orgId,
						   id: "source",
						   projectionEpoch: $projectionEpoch,
						   liveRegressionHarness: $liveRegressionHarness,
						   liveRegressionRunId: $liveRegressionRunId
						 })
						 CREATE (target:Fact {
						   orgId: $orgId,
						   id: "target",
						   projectionEpoch: $projectionEpoch,
						   liveRegressionHarness: $liveRegressionHarness,
						   liveRegressionRunId: $liveRegressionRunId
						 })
						 CREATE (source)-[:RELATED_TO {
						   projectionEpoch: $projectionEpoch
						 }]->(target)
						 CREATE (source)-[:RELATED_TO {
						   projectionEpoch: $projectionEpoch
						 }]->(target)`,
					{
						orgId: sentinelOrganizationId,
						projectionEpoch,
						liveRegressionHarness: LIVE_REGRESSION_HARNESS,
						liveRegressionRunId,
					},
				);
				await runCypherWithParams(
					config,
					`MATCH (source:Fact {orgId: $sourceOrgId, id: "source-1"})
						 MATCH (target:Fact {orgId: $targetOrgId, id: "target"})
						 CREATE (source)-[:RELATED_TO {
						   projectionEpoch: $projectionEpoch,
						   liveRegressionHarness: $liveRegressionHarness,
						   liveRegressionRunId: $liveRegressionRunId
						 }]->(target)`,
					{
						sourceOrgId: organizationId,
						targetOrgId: sentinelOrganizationId,
						projectionEpoch,
						liveRegressionHarness: LIVE_REGRESSION_HARNESS,
						liveRegressionRunId,
					},
				);

				const profiled = await profileCleanupBatch(config, organizationId);
				expect(profiled.removed).toBe(GRAPH_PROJECTION_CLEANUP_BATCH_SIZE);
				const batchLimit = findPlanNode(profiled.plan, (node) => {
					const details = String(node.arguments?.Details ?? "");
					return (
						String(node.operatorType ?? "").startsWith("Limit") &&
						details.includes("$batchSize")
					);
				});
				expect(batchLimit).not.toBeNull();
				expect(
					Number(batchLimit?.arguments?.Rows ?? Number.NaN),
				).toBeLessThanOrEqual(GRAPH_PROJECTION_CLEANUP_BATCH_SIZE);
				const discoveryOperators = collectOperatorTypes(
					planChildren(batchLimit!)[0]!,
				);
				expect(discoveryOperators).not.toEqual(
					expect.arrayContaining([
						expect.stringMatching(/Sort|Eager|Aggregation/),
					]),
				);
				expect(
					Number(profiled.plan.arguments?.GlobalMemory ?? Number.NaN),
				).toBeLessThan(16 * 1024 * 1024);

				const beforeBatch = vi.fn(async () => undefined);
				const sweepResult = await sweepGraphProjectionEpoch({
					env,
					organizationId,
					projectionEpoch,
					beforeBatch,
				});
				expect(sweepResult).toMatchObject({
					relationshipsRemoved: 0,
					attachedRelationshipsRemoved: 0,
					nodesRemoved: 0,
					duplicateRelationshipsRemoved:
						EXPECTED_BASE_DUPLICATES +
						EXPECTED_VARIANT_DUPLICATES -
						GRAPH_PROJECTION_CLEANUP_BATCH_SIZE,
				});
				expect(beforeBatch).toHaveBeenCalledTimes(13);

				const [remaining] = await runCypherWithParams(
					config,
					`MATCH (source {orgId: $orgId})-[relationship]->(target {
						   orgId: $orgId
						 })
						 RETURN count(relationship) AS relationshipCount`,
					{ orgId: organizationId },
				);
				expect(Number(remaining?.relationshipCount)).toBe(PAIR_COUNT + 2);
				const remainingGroups = await runCypherWithParams(
					config,
					`MATCH (source {orgId: $orgId})-[relationship]->(target {
						   orgId: $orgId
						 })
						 RETURN source.id AS sourceId,
						   target.id AS targetId,
						   type(relationship) AS relationshipType,
						   count(relationship) AS relationshipCount`,
					{ orgId: organizationId },
				);
				expect(remainingGroups).toHaveLength(PAIR_COUNT + 2);
				expect(
					remainingGroups.every(
						(group) => Number(group.relationshipCount) === 1,
					),
				).toBe(true);

				const [sentinel] = await runCypherWithParams(
					config,
					`MATCH (source {orgId: $orgId})-[relationship]->(target {
						   orgId: $orgId
						 })
						 RETURN count(relationship) AS relationshipCount`,
					{ orgId: sentinelOrganizationId },
				);
				expect(Number(sentinel?.relationshipCount)).toBe(2);
				const [crossOrganization] = await runCypherWithParams(
					config,
					`MATCH (source {orgId: $sourceOrgId})-[relationship]->(target {
						   orgId: $targetOrgId
						 })
						 RETURN count(relationship) AS relationshipCount`,
					{
						sourceOrgId: organizationId,
						targetOrgId: sentinelOrganizationId,
					},
				);
				expect(Number(crossOrganization?.relationshipCount)).toBe(1);

				const replayBeforeBatch = vi.fn(async () => undefined);
				await expect(
					sweepGraphProjectionEpoch({
						env,
						organizationId,
						projectionEpoch,
						beforeBatch: replayBeforeBatch,
					}),
				).resolves.toMatchObject({
					duplicateRelationshipsRemoved: 0,
				});
				expect(replayBeforeBatch).toHaveBeenCalledTimes(4);
				console.info(
					"real Neo4j duplicate cleanup evidence",
					JSON.stringify({
						profiledBatchRemoved: profiled.removed,
						batchLimitRows: Number(batchLimit?.arguments?.Rows),
						globalMemoryBytes: Number(profiled.plan.arguments?.GlobalMemory),
						sweepDuplicatesRemoved: sweepResult.duplicateRelationshipsRemoved,
						remainingRelationships: Number(remaining?.relationshipCount),
						sentinelRelationships: Number(sentinel?.relationshipCount),
						crossOrganizationRelationships: Number(
							crossOrganization?.relationshipCount,
						),
					}),
				);
			} finally {
				for (const orgId of [organizationId, sentinelOrganizationId]) {
					await runCypherWithParams(
						config,
						"MATCH (node:Fact {orgId: $orgId}) DETACH DELETE node",
						{
							orgId,
						},
					);
				}
			}
		}, 120_000);
	},
);
