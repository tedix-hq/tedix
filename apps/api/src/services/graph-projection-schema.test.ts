import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const graphMocks = vi.hoisted(() => ({
	runCypherWithParams: vi.fn(),
}));

vi.mock("../integrations/graph-db/client", () => ({
	runCypherWithParams: graphMocks.runCypherWithParams,
}));

import {
	ensureGraphProjectionSchema,
	GRAPH_PROJECTION_INDEX_STATEMENTS,
	GRAPH_PROJECTION_SCHEMA_STATEMENTS,
	readGraphProjectionSchemaState,
	sweepGraphProjectionEpoch,
	sweepGraphProjectionRepair,
} from "./graph-projection-schema";

function completeConstraintRows(type = "UNIQUENESS") {
	return GRAPH_PROJECTION_SCHEMA_STATEMENTS.map(({ name }, index) => ({
		name: index === 0 ? "legacy_equivalent_name" : name,
		type,
		entityType: "NODE",
		labelsOrTypes: [
			name
				.replace("graph_projection_", "")
				.replace("_org_id_v1", "")
				.replace("approvalrequest", "ApprovalRequest")
				.replace("entityresolutiondecision", "EntityResolutionDecision")
				.replace("entityresolution", "EntityResolution")
				.replace("knowledgeentry", "KnowledgeEntry")
				.replace(/^\w/, (value) => value.toUpperCase()),
		],
		properties: ["orgId", "id"],
	}));
}

function expectStreamingDuplicateCleanupQuery(query: unknown) {
	const cypher = String(query);
	expect(cypher).toContain(
		"MATCH (source {orgId: $orgId})-[duplicate]->(target {orgId: $orgId})",
	);
	expect(cypher).toContain("AND EXISTS {");
	expect(cypher).toContain("MATCH (source)-[keeper]->(target)");
	expect(cypher).toContain("type(keeper) = type(duplicate)");
	expect(cypher).toContain("elementId(keeper) < elementId(duplicate)");
	expect(cypher).not.toContain("ORDER BY");
	expect(cypher).not.toContain("collect(");

	const limitIndex = cypher.indexOf("LIMIT $batchSize");
	const deleteIndex = cypher.indexOf("DELETE duplicate");
	expect(limitIndex).toBeGreaterThan(-1);
	expect(deleteIndex).toBeGreaterThan(limitIndex);
}

describe("graph projection Neo4j schema and repair sweep", () => {
	beforeEach(() => {
		graphMocks.runCypherWithParams.mockReset();
		graphMocks.runCypherWithParams.mockResolvedValue([]);
	});

	it("idempotently provisions composite tenant identity constraints", async () => {
		await ensureGraphProjectionSchema({} as CloudflareEnv);

		expect(graphMocks.runCypherWithParams).toHaveBeenCalledTimes(
			GRAPH_PROJECTION_SCHEMA_STATEMENTS.length +
				GRAPH_PROJECTION_INDEX_STATEMENTS.length,
		);
		for (const [
			,
			query,
			parameters,
		] of graphMocks.runCypherWithParams.mock.calls.slice(
			0,
			GRAPH_PROJECTION_SCHEMA_STATEMENTS.length,
		)) {
			expect(query).toContain("IF NOT EXISTS");
			expect(query).toContain("REQUIRE (n.orgId, n.id) IS UNIQUE");
			expect(parameters).toEqual({});
		}
		const indexCall =
			graphMocks.runCypherWithParams.mock.calls[
				GRAPH_PROJECTION_SCHEMA_STATEMENTS.length
			];
		expect(indexCall?.[1]).toContain(
			"ON (d.orgId, d.tediId, d.category, d.createdAt)",
		);
		expect(indexCall?.[2]).toEqual({});
		expect(
			GRAPH_PROJECTION_SCHEMA_STATEMENTS.some(
				(statement) => statement.name === "graph_projection_episode_org_id_v1",
			),
		).toBe(true);
	});

	it("reports whether every required constraint is observable", async () => {
		graphMocks.runCypherWithParams.mockResolvedValueOnce(
			completeConstraintRows(),
		);
		graphMocks.runCypherWithParams.mockResolvedValueOnce([
			{
				name: GRAPH_PROJECTION_INDEX_STATEMENTS[0].name,
				type: "RANGE",
				entityType: "NODE",
				labelsOrTypes: ["Decision"],
				properties: ["orgId", "tediId", "category", "createdAt"],
				state: "ONLINE",
			},
		]);

		await expect(
			readGraphProjectionSchemaState({} as CloudflareEnv),
		).resolves.toMatchObject({
			version: "graph-projection-schema-v2",
			complete: true,
		});

		graphMocks.runCypherWithParams.mockResolvedValueOnce([
			{
				name: GRAPH_PROJECTION_SCHEMA_STATEMENTS[0]!.name,
				type: "UNIQUENESS",
				entityType: "NODE",
				labelsOrTypes: ["Fact"],
				properties: ["orgId", "id"],
			},
		]);
		graphMocks.runCypherWithParams.mockResolvedValueOnce([]);
		await expect(
			readGraphProjectionSchemaState({} as CloudflareEnv),
		).resolves.toMatchObject({
			complete: false,
		});
	});

	it.each(["UNIQUENESS", "NODE_PROPERTY_UNIQUENESS", "NODE_KEY"])(
		"accepts Neo4j tenant identity constraint type %s",
		async (constraintType) => {
			graphMocks.runCypherWithParams.mockResolvedValueOnce(
				completeConstraintRows(constraintType),
			);
			graphMocks.runCypherWithParams.mockResolvedValueOnce([
				{
					name: GRAPH_PROJECTION_INDEX_STATEMENTS[0].name,
					type: "RANGE",
					entityType: "NODE",
					labelsOrTypes: ["Decision"],
					properties: ["orgId", "tediId", "category", "createdAt"],
					state: "ONLINE",
				},
			]);

			await expect(
				readGraphProjectionSchemaState({} as CloudflareEnv),
			).resolves.toMatchObject({
				complete: true,
			});
		},
	);

	it("rejects unsupported tenant identity constraint types and properties", async () => {
		for (const constraintRows of [
			completeConstraintRows("NODE_PROPERTY_EXISTENCE"),
			completeConstraintRows().map((row, index) =>
				index === 0 ? { ...row, properties: ["orgId", "wrongId"] } : row,
			),
			completeConstraintRows().map((row, index) =>
				index === 0 ? { ...row, properties: ["orgId"] } : row,
			),
		]) {
			graphMocks.runCypherWithParams.mockResolvedValueOnce(constraintRows);
			graphMocks.runCypherWithParams.mockResolvedValueOnce([
				{
					name: GRAPH_PROJECTION_INDEX_STATEMENTS[0].name,
					type: "RANGE",
					entityType: "NODE",
					labelsOrTypes: ["Decision"],
					properties: ["orgId", "tediId", "category", "createdAt"],
					state: "ONLINE",
				},
			]);

			await expect(
				readGraphProjectionSchemaState({} as CloudflareEnv),
			).resolves.toMatchObject({
				complete: false,
			});
		}
	});

	it("rejects the predecessor index when type or property order is wrong", async () => {
		for (const index of [
			{
				type: "TEXT",
				properties: ["orgId", "tediId", "category", "createdAt"],
				state: "ONLINE",
			},
			{
				type: "RANGE",
				properties: ["orgId", "category", "tediId", "createdAt"],
				state: "ONLINE",
			},
			{
				type: "RANGE",
				properties: ["orgId", "tediId", "category", "createdAt"],
				state: "POPULATING",
			},
		]) {
			graphMocks.runCypherWithParams.mockResolvedValueOnce(
				completeConstraintRows(),
			);
			graphMocks.runCypherWithParams.mockResolvedValueOnce([
				{
					name: GRAPH_PROJECTION_INDEX_STATEMENTS[0].name,
					type: index.type,
					entityType: "NODE",
					labelsOrTypes: ["Decision"],
					properties: index.properties,
					state: index.state,
				},
			]);

			await expect(
				readGraphProjectionSchemaState({} as CloudflareEnv),
			).resolves.toMatchObject({
				complete: false,
			});
		}
	});

	it("sweeps only managed rows inside one organization and repair epoch", async () => {
		graphMocks.runCypherWithParams
			.mockResolvedValueOnce([{ removed: 3 }])
			.mockResolvedValueOnce([{ removed: 4 }])
			.mockResolvedValueOnce([{ removed: 2 }])
			.mockResolvedValueOnce([{ removed: 1 }]);

		await expect(
			sweepGraphProjectionRepair({
				env: {} as CloudflareEnv,
				organizationId: "org-1",
				repairEpoch: "repair-7",
			}),
		).resolves.toEqual({
			relationshipsRemoved: 3,
			attachedRelationshipsRemoved: 4,
			nodesRemoved: 2,
			duplicateRelationshipsRemoved: 1,
		});

		const [, relationshipQuery, relationshipParameters] =
			graphMocks.runCypherWithParams.mock.calls[0]!;
		const [, nodeQuery, nodeParameters] =
			graphMocks.runCypherWithParams.mock.calls[2]!;
		const [, duplicateQuery] = graphMocks.runCypherWithParams.mock.calls[3]!;
		expect(relationshipQuery).toContain(
			"MATCH (source {orgId: $orgId})-[r]->(target {orgId: $orgId})",
		);
		expect(relationshipQuery).toContain("LIMIT $batchSize");
		expect(nodeQuery).toContain("MATCH (n {orgId: $orgId})");
		expect(nodeQuery).toContain("AND NOT (n)--()");
		expect(relationshipParameters).toMatchObject({
			orgId: "org-1",
			repairEpoch: "repair-7",
			batchSize: 500,
		});
		expect(nodeParameters).toMatchObject({
			orgId: "org-1",
			repairEpoch: "repair-7",
			batchSize: 500,
		});
		expectStreamingDuplicateCleanupQuery(duplicateQuery);
	});

	it("continues full cleanup batches until a partial batch proves exhaustion", async () => {
		const beforeBatch = vi.fn(async () => undefined);
		graphMocks.runCypherWithParams
			.mockResolvedValueOnce([{ removed: 500 }])
			.mockResolvedValueOnce([{ removed: 3 }])
			.mockResolvedValueOnce([{ removed: 0 }])
			.mockResolvedValueOnce([{ removed: 0 }])
			.mockResolvedValueOnce([{ removed: 0 }]);

		await expect(
			sweepGraphProjectionRepair({
				env: {} as CloudflareEnv,
				organizationId: "org-1",
				repairEpoch: "repair-7",
				projectionEpoch: "generation-2",
				beforeBatch,
			}),
		).resolves.toMatchObject({ relationshipsRemoved: 503 });

		expect(graphMocks.runCypherWithParams).toHaveBeenCalledTimes(5);
		expect(graphMocks.runCypherWithParams.mock.calls[0]?.[2]).toMatchObject({
			projectionEpoch: "generation-2",
		});
		expect(beforeBatch).toHaveBeenCalledTimes(5);
		const relationshipQuery = String(
			graphMocks.runCypherWithParams.mock.calls[0]?.[1],
		);
		expect(relationshipQuery).toMatch(
			/projectionRepairEpoch[\s\S]*AND \([\s\S]*projectionEpoch/,
		);
		expect(relationshipQuery).not.toMatch(
			/projectionRepairEpoch[\s\S]*\n\s*OR \(/,
		);
	});

	it("streams duplicate cleanup in bounded mutation batches", async () => {
		const beforeBatch = vi.fn(async () => undefined);
		graphMocks.runCypherWithParams
			.mockResolvedValueOnce([{ removed: 0 }])
			.mockResolvedValueOnce([{ removed: 0 }])
			.mockResolvedValueOnce([{ removed: 0 }])
			.mockResolvedValueOnce([{ removed: 500 }])
			.mockResolvedValueOnce([{ removed: 2 }]);

		await expect(
			sweepGraphProjectionRepair({
				env: {} as CloudflareEnv,
				organizationId: "org-1",
				repairEpoch: "repair-7",
				projectionEpoch: "generation-2",
				beforeBatch,
			}),
		).resolves.toMatchObject({
			duplicateRelationshipsRemoved: 502,
		});

		expect(graphMocks.runCypherWithParams).toHaveBeenCalledTimes(5);
		expect(beforeBatch).toHaveBeenCalledTimes(5);
		const [, firstDuplicateQuery, firstDuplicateParameters] =
			graphMocks.runCypherWithParams.mock.calls[3]!;
		const [, secondDuplicateQuery, secondDuplicateParameters] =
			graphMocks.runCypherWithParams.mock.calls[4]!;
		expectStreamingDuplicateCleanupQuery(firstDuplicateQuery);
		expect(secondDuplicateQuery).toBe(firstDuplicateQuery);
		expect(firstDuplicateParameters).toMatchObject({
			orgId: "org-1",
			managedRelationshipTypes: expect.arrayContaining([
				"RELATED_TO",
				"PRECEDED_BY",
			]),
			batchSize: 500,
		});
		expect(secondDuplicateParameters).toEqual(firstDuplicateParameters);
	});

	it("preserves post-baseline rows by sweeping a caught-up generation without a repair token", async () => {
		graphMocks.runCypherWithParams
			.mockResolvedValueOnce([{ removed: 1 }])
			.mockResolvedValueOnce([{ removed: 2 }])
			.mockResolvedValueOnce([{ removed: 3 }])
			.mockResolvedValueOnce([{ removed: 4 }]);

		await expect(
			sweepGraphProjectionEpoch({
				env: {} as CloudflareEnv,
				organizationId: "org-1",
				projectionEpoch: "generation-2",
			}),
		).resolves.toEqual({
			relationshipsRemoved: 1,
			attachedRelationshipsRemoved: 2,
			nodesRemoved: 3,
			duplicateRelationshipsRemoved: 4,
		});

		for (const [, query, parameters] of graphMocks.runCypherWithParams.mock
			.calls) {
			expect(query).not.toContain("projectionRepairEpoch");
			expect(parameters).toMatchObject({
				orgId: "org-1",
				projectionEpoch: "generation-2",
				batchSize: 500,
			});
			expect(parameters).not.toHaveProperty("repairEpoch");
		}
		expectStreamingDuplicateCleanupQuery(
			graphMocks.runCypherWithParams.mock.calls[3]?.[1],
		);
	});
});
