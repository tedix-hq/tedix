/**
 * Versioned Neo4j schema and org-scoped repair sweep.
 *
 * D1 migrations cannot create Neo4j constraints. The first scheduled/manual
 * writer in each Worker isolate idempotently provisions the current schema
 * before applying or certifying projection data.
 */

/// <reference path="../../worker-configuration.d.ts" />

import { runCypherWithParams } from "../integrations/graph-db/client";

export const GRAPH_PROJECTION_SCHEMA_VERSION = "graph-projection-schema-v2";

export type GraphProjectionSchemaState = {
	version: string;
	constraints: string[];
	complete: boolean;
};

export const MANAGED_NODE_LABELS = [
	"Fact",
	"Domain",
	"Tedi",
	"Decision",
	"Episode",
	"KnowledgeEntry",
	"Skill",
	"Capability",
	"Entity",
	"EntityResolution",
	"EntityResolutionDecision",
	"Outcome",
	"Objective",
	"ApprovalRequest",
	"App",
] as const;

export const MANAGED_RELATIONSHIP_TYPES = [
	"CAUSED_BY",
	"CONTRADICTS",
	"SUPERSEDES",
	"APPLIES_TO",
	"LEARNED_FROM",
	"REQUIRES",
	"RELATED_TO",
	"IN_DOMAIN",
	"OWNED_BY",
	"PARENT_OF",
	"DECIDED_BY",
	"COMPLETED_AS",
	"SERVES_OBJECTIVE",
	"GATED_BY",
	"INFORMED_BY",
	"USED",
	"IGNORED",
	"PRECEDED_BY",
	"SYNTHESIZED_FROM",
	"OPERATES_IN",
	"EXPERT_IN",
	"PROMOTED_FROM",
	"SUPPORTS",
	"MERGED_INTO",
	"RESOLVES_TO",
	"SUPPORTED_BY",
	"DECIDED_IN",
] as const;

export const GRAPH_PROJECTION_SCHEMA_STATEMENTS = MANAGED_NODE_LABELS.map(
	(label) => ({
		name: `graph_projection_${label.toLowerCase()}_org_id_v1`,
		query: `CREATE CONSTRAINT graph_projection_${label.toLowerCase()}_org_id_v1 IF NOT EXISTS
			FOR (n:${label}) REQUIRE (n.orgId, n.id) IS UNIQUE`,
	}),
);

export const GRAPH_PROJECTION_INDEX_STATEMENTS = [
	{
		name: "graph_projection_decision_predecessor_lookup_v1",
		query: `CREATE RANGE INDEX graph_projection_decision_predecessor_lookup_v1 IF NOT EXISTS
			FOR (d:Decision) ON (d.orgId, d.tediId, d.category, d.createdAt)`,
	},
] as const;

let schemaProvisioning: Promise<void> | null = null;
export const GRAPH_PROJECTION_CLEANUP_BATCH_SIZE = 500;
const MAX_CLEANUP_BATCHES = 10_000;

/**
 * Collapse duplicate managed relationships without sorting or aggregating the
 * tenant's full relationship cohort. `EXISTS` stops after one lower-element-id
 * keeper is found, then `LIMIT` bounds the eager read/delete isolation buffer
 * to one cleanup batch. The element id is compared only inside this
 * transaction; it is never persisted or used as a cross-request cursor.
 */
export const DUPLICATE_MANAGED_RELATIONSHIP_CLEANUP_QUERY = `
	MATCH (source {orgId: $orgId})-[duplicate]->(target {orgId: $orgId})
	WHERE type(duplicate) IN $managedRelationshipTypes
	  AND EXISTS {
		MATCH (source)-[keeper]->(target)
		WHERE type(keeper) = type(duplicate)
		  AND elementId(keeper) < elementId(duplicate)
	  }
	WITH duplicate
	LIMIT $batchSize
	DELETE duplicate
	RETURN count(duplicate) AS removed
`;

async function runBoundedCleanup(input: {
	env: CloudflareEnv;
	query: string;
	parameters: Record<string, unknown>;
	name: string;
	beforeBatch?: () => Promise<void>;
}): Promise<number> {
	let total = 0;
	for (let batch = 0; batch < MAX_CLEANUP_BATCHES; batch++) {
		await input.beforeBatch?.();
		const [row] = await runCypherWithParams(input.env, input.query, {
			...input.parameters,
			batchSize: GRAPH_PROJECTION_CLEANUP_BATCH_SIZE,
		});
		const removed = Number(row?.removed ?? 0);
		total += removed;
		if (removed < GRAPH_PROJECTION_CLEANUP_BATCH_SIZE) return total;
	}
	throw new Error(
		`${input.name} exceeded ${MAX_CLEANUP_BATCHES} bounded cleanup batches`,
	);
}

export async function ensureGraphProjectionSchema(
	env: CloudflareEnv,
): Promise<void> {
	if (!schemaProvisioning) {
		schemaProvisioning = (async () => {
			for (const statement of GRAPH_PROJECTION_SCHEMA_STATEMENTS) {
				await runCypherWithParams(env, statement.query, {});
			}
			for (const statement of GRAPH_PROJECTION_INDEX_STATEMENTS) {
				await runCypherWithParams(env, statement.query, {});
			}
		})().catch((error) => {
			schemaProvisioning = null;
			throw error;
		});
	}
	await schemaProvisioning;
}

export async function sweepGraphProjectionRepair(input: {
	env: CloudflareEnv;
	organizationId: string;
	repairEpoch: string;
	projectionEpoch?: string;
	beforeBatch?: () => Promise<void>;
}): Promise<{
	relationshipsRemoved: number;
	attachedRelationshipsRemoved: number;
	duplicateRelationshipsRemoved: number;
	nodesRemoved: number;
}> {
	const parameters = {
		orgId: input.organizationId,
		repairEpoch: input.repairEpoch,
		projectionEpoch: input.projectionEpoch ?? null,
		managedRelationshipTypes: [...MANAGED_RELATIONSHIP_TYPES],
		managedNodeLabels: [...MANAGED_NODE_LABELS],
	};
	const relationshipsRemoved = await runBoundedCleanup({
		env: input.env,
		name: "stale managed relationship sweep",
		query: `
		MATCH (source {orgId: $orgId})-[r]->(target {orgId: $orgId})
		WHERE type(r) IN $managedRelationshipTypes
		  AND (
			coalesce(r.projectionRepairEpoch, '') <> $repairEpoch
			AND (
				$projectionEpoch IS NULL
				OR coalesce(r.projectionEpoch, '') <> $projectionEpoch
			)
		  )
		WITH r
		LIMIT $batchSize
		DELETE r
		RETURN count(r) AS removed
		`,
		parameters,
		beforeBatch: input.beforeBatch,
	});
	const attachedRelationshipsRemoved = await runBoundedCleanup({
		env: input.env,
		name: "stale node relationship sweep",
		query: `
		MATCH (n {orgId: $orgId})-[r]-()
		WHERE any(label IN labels(n) WHERE label IN $managedNodeLabels)
		  AND (
			coalesce(n.projectionRepairEpoch, '') <> $repairEpoch
			AND (
				$projectionEpoch IS NULL
				OR coalesce(n.projectionEpoch, '') <> $projectionEpoch
			)
		  )
		WITH DISTINCT r
		LIMIT $batchSize
		DELETE r
		RETURN count(r) AS removed
		`,
		parameters,
		beforeBatch: input.beforeBatch,
	});
	const nodesRemoved = await runBoundedCleanup({
		env: input.env,
		name: "stale isolated node sweep",
		query: `
		MATCH (n {orgId: $orgId})
		WHERE any(label IN labels(n) WHERE label IN $managedNodeLabels)
		  AND (
			coalesce(n.projectionRepairEpoch, '') <> $repairEpoch
			AND (
				$projectionEpoch IS NULL
				OR coalesce(n.projectionEpoch, '') <> $projectionEpoch
			)
		  )
		  AND NOT (n)--()
		WITH n
		LIMIT $batchSize
		DELETE n
		RETURN count(n) AS removed
		`,
		parameters,
		beforeBatch: input.beforeBatch,
	});
	const duplicateRelationshipsRemoved = await runBoundedCleanup({
		env: input.env,
		name: "duplicate managed relationship sweep",
		query: DUPLICATE_MANAGED_RELATIONSHIP_CLEANUP_QUERY,
		parameters,
		beforeBatch: input.beforeBatch,
	});
	return {
		relationshipsRemoved,
		attachedRelationshipsRemoved,
		duplicateRelationshipsRemoved,
		nodesRemoved,
	};
}

/**
 * Remove rows from prior projection generations after the ordered outbox is
 * caught up. Unlike the baseline repair sweep, this intentionally ignores
 * projectionRepairEpoch: rows created after the baseline high-water mark were
 * drained normally and therefore do not carry the baseline repair token.
 */
export async function sweepGraphProjectionEpoch(input: {
	env: CloudflareEnv;
	organizationId: string;
	projectionEpoch: string;
	beforeBatch?: () => Promise<void>;
}): Promise<{
	relationshipsRemoved: number;
	attachedRelationshipsRemoved: number;
	duplicateRelationshipsRemoved: number;
	nodesRemoved: number;
}> {
	const parameters = {
		orgId: input.organizationId,
		projectionEpoch: input.projectionEpoch,
		managedRelationshipTypes: [...MANAGED_RELATIONSHIP_TYPES],
		managedNodeLabels: [...MANAGED_NODE_LABELS],
	};
	const relationshipsRemoved = await runBoundedCleanup({
		env: input.env,
		name: "prior projection relationship sweep",
		query: `
		MATCH (source {orgId: $orgId})-[r]->(target {orgId: $orgId})
		WHERE type(r) IN $managedRelationshipTypes
		  AND coalesce(r.projectionEpoch, '') <> $projectionEpoch
		WITH r
		LIMIT $batchSize
		DELETE r
		RETURN count(r) AS removed
		`,
		parameters,
		beforeBatch: input.beforeBatch,
	});
	const attachedRelationshipsRemoved = await runBoundedCleanup({
		env: input.env,
		name: "prior projection node relationship sweep",
		query: `
		MATCH (n {orgId: $orgId})-[r]-()
		WHERE any(label IN labels(n) WHERE label IN $managedNodeLabels)
		  AND coalesce(n.projectionEpoch, '') <> $projectionEpoch
		WITH DISTINCT r
		LIMIT $batchSize
		DELETE r
		RETURN count(r) AS removed
		`,
		parameters,
		beforeBatch: input.beforeBatch,
	});
	const nodesRemoved = await runBoundedCleanup({
		env: input.env,
		name: "prior projection isolated node sweep",
		query: `
		MATCH (n {orgId: $orgId})
		WHERE any(label IN labels(n) WHERE label IN $managedNodeLabels)
		  AND coalesce(n.projectionEpoch, '') <> $projectionEpoch
		  AND NOT (n)--()
		WITH n
		LIMIT $batchSize
		DELETE n
		RETURN count(n) AS removed
		`,
		parameters,
		beforeBatch: input.beforeBatch,
	});
	const duplicateRelationshipsRemoved = await runBoundedCleanup({
		env: input.env,
		name: "duplicate managed relationship sweep",
		query: DUPLICATE_MANAGED_RELATIONSHIP_CLEANUP_QUERY,
		parameters,
		beforeBatch: input.beforeBatch,
	});
	return {
		relationshipsRemoved,
		attachedRelationshipsRemoved,
		duplicateRelationshipsRemoved,
		nodesRemoved,
	};
}

export async function readGraphProjectionSchemaState(
	env: CloudflareEnv,
): Promise<GraphProjectionSchemaState> {
	const constraintRows = await runCypherWithParams(
		env,
		`SHOW CONSTRAINTS
		 YIELD name, type, entityType, labelsOrTypes, properties
		 RETURN name, type, entityType, labelsOrTypes, properties
		 ORDER BY name`,
		{},
	);
	const indexRows = await runCypherWithParams(
		env,
		`SHOW INDEXES
		 YIELD name, type, entityType, labelsOrTypes, properties, state
		 RETURN name, type, entityType, labelsOrTypes, properties, state
		 ORDER BY name`,
		{},
	);
	const constraints = constraintRows
		.map((row) => String(row.name ?? ""))
		.filter(Boolean);
	const hasTenantIdentityConstraint = (label: string) =>
		constraintRows.some((row) => {
			const labels = Array.isArray(row.labelsOrTypes)
				? row.labelsOrTypes.map(String)
				: [];
			const properties = Array.isArray(row.properties)
				? row.properties.map(String)
				: [];
			return (
				String(row.entityType ?? "").toUpperCase() === "NODE" &&
				["UNIQUENESS", "NODE_PROPERTY_UNIQUENESS", "NODE_KEY"].includes(
					String(row.type ?? "").toUpperCase(),
				) &&
				labels.includes(label) &&
				properties.length === 2 &&
				properties.includes("orgId") &&
				properties.includes("id")
			);
		});
	const hasDecisionPredecessorIndex = indexRows.some((row) => {
		const labels = Array.isArray(row.labelsOrTypes)
			? row.labelsOrTypes.map(String)
			: [];
		const properties = Array.isArray(row.properties)
			? row.properties.map(String)
			: [];
		const expectedProperties = ["orgId", "tediId", "category", "createdAt"];
		return (
			String(row.type ?? "").toUpperCase() === "RANGE" &&
			String(row.entityType ?? "").toUpperCase() === "NODE" &&
			String(row.state ?? "").toUpperCase() === "ONLINE" &&
			labels.length === 1 &&
			labels[0] === "Decision" &&
			properties.length === expectedProperties.length &&
			properties.every(
				(property, index) => property === expectedProperties[index],
			)
		);
	});
	return {
		version: GRAPH_PROJECTION_SCHEMA_VERSION,
		constraints,
		// Neo4j IF NOT EXISTS accepts a semantically equivalent pre-existing
		// constraint without creating our preferred name. Readiness therefore
		// certifies the actual tenant-identity schema, not a naming convention.
		complete:
			MANAGED_NODE_LABELS.every(hasTenantIdentityConstraint) &&
			hasDecisionPredecessorIndex,
	};
}
