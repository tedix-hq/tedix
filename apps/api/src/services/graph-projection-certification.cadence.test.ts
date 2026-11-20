import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "@tedix/db/client";
import {
	getGraphProjectionBacklogStats,
	getGraphProjectionReadState,
	setGraphProjectionReadiness,
} from "@tedix/db/queries/graph-projection";
import {
	getGraphProjectionCanonicalManagedCounts,
	getGraphProjectionManagedCountAttempt,
} from "@tedix/db/queries/graph-projection-health";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";

const graph = vi.hoisted(() => ({
	healthy: true,
	readable: true,
	projected: null as Record<string, number> | null,
	projectedReads: 0,
}));
vi.mock("../integrations/graph-db/client", () => ({
	getGraphClient: () => ({ isHealthy: async () => graph.healthy }),
	runCypherWithParams: async () => [],
}));
vi.mock("../integrations/graph-projection-health", async (original) => ({
	...(await original<
		typeof import("../integrations/graph-projection-health")
	>()),
	readGraphProjectionRows: async (
		_env: unknown,
		_orgId: string,
		ids: string[],
	) =>
		ids.map((id) => ({
			factId: id,
			projectedFactId: id,
			projectedUpdatedAt: "2026-11-16T00:00:00.000Z",
			projectedValidTo: null,
			projectedArchivedAt: null,
		})),
	readGraphProjectionEdgeRows: async (
		_env: unknown,
		_orgId: string,
		edges: Array<{
			id: string;
			sourceFactId: string;
			targetFactId: string;
			relationType: string;
		}>,
	) =>
		edges.map((edge) => ({
			edgeId: edge.id,
			projectedEdgeId: edge.id,
			projectedSourceFactId: edge.sourceFactId,
			projectedTargetFactId: edge.targetFactId,
			projectedRelationType: edge.relationType,
		})),
	readGraphProjectionManagedCounts: async () => {
		graph.projectedReads++;
		if (!graph.readable) throw new Error("projection read failed");
		return graph.projected;
	},
}));
vi.mock("./graph-projection-schema", async (original) => ({
	...(await original<typeof import("./graph-projection-schema")>()),
	readGraphProjectionSchemaState: async () => ({
		version: "test",
		constraints: [],
		complete: true,
	}),
}));

import {
	GRAPH_PROJECTION_MANAGED_COUNT_QUICK_RETRIES,
	certifyGraphProjection,
	inspectGraphProjection,
} from "./graph-projection-certification";

const ORG = "org-example";
const env = {} as CloudflareEnv;

afterEach(() => {
	vi.useRealTimers();
	Object.assign(graph, {
		healthy: true,
		readable: true,
		projected: null,
		projectedReads: 0,
	});
});

async function fixture() {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	sqlite.exec(`INSERT INTO tedis (id, organization_id, name, slug) VALUES ('tedi', '${ORG}', 'Example', 'example');
		INSERT INTO memory_facts (id, organization_id, content, fact_type, created_at, updated_at) VALUES
			('fact-a', '${ORG}', 'Example', 'technical', '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z'),
			('fact-b', '${ORG}', 'Example', 'technical', '2026-11-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z');
		INSERT INTO memory_edges (id, source_fact_id, target_fact_id, relation_type, created_at) VALUES ('edge', 'fact-a', 'fact-b', 'related_to', '2026-11-16T00:00:00.000Z');
		INSERT INTO tedi_rationale_records (id, tedi_id, org_id, action, rationale, category, created_at) VALUES ('decision', 'tedi', '${ORG}', 'action', 'why', 'custom', '2026-11-16');
		-- Every change above is already projected.
		INSERT INTO graph_projection_consumers (organization_id, last_projected_sequence)
			SELECT '${ORG}', coalesce(max(sequence), 0) FROM graph_projection_outbox;`);
	let inventories = 0;
	const db = createDbClient(
		createD1Facade({
			prepare(query) {
				if (query.includes("memory_edge_org_counts")) inventories++;
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	await setGraphProjectionReadiness(db, {
		organizationId: ORG,
		state: "catching_up",
		projectionEpoch: "generation-a",
		repairId: "repair-1",
		repairPhase: "complete",
		repairHighWater: 0,
	});
	expect((await getGraphProjectionBacklogStats(db, ORG)).pendingCount).toBe(0);
	const canonical = await getGraphProjectionCanonicalManagedCounts(db, ORG);
	inventories = 0;
	const tick = async (
		time: string,
		managedCounts: "exact" | "hourly" = "hourly",
	) => {
		vi.setSystemTime(new Date(time));
		// The drain overwrites the stored reason before it certifies.
		await setGraphProjectionReadiness(db, {
			organizationId: ORG,
			state: "catching_up",
			reason: "outbox_drain_in_progress",
		});
		const before = { inventories, projectedReads: graph.projectedReads };
		const inspection = await certifyGraphProjection({
			db,
			env,
			organizationId: ORG,
			checkedAt: time,
			managedCounts,
		});
		return {
			inspection,
			state: inspection.readiness?.state,
			reason: inspection.readiness?.reason,
			inventories: inventories - before.inventories,
			projectedReads: graph.projectedReads - before.projectedReads,
		};
	};
	return { db, canonical, tick };
}

const minute = (hour: number, m: number) =>
	`2026-11-17T${String(hour).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

describe("drain certification while the projection stays out of parity", () => {
	it("counts a few times, then once an hour, and keeps reporting the same mismatch", async () => {
		vi.useFakeTimers();
		const { db, canonical, tick } = await fixture();
		expect(canonical).toMatchObject({ facts: 2, edges: 1, decisions: 1 });
		// One relationship too many in the projection.
		graph.projected = { ...canonical, edges: canonical.edges + 1 };

		const counted = [];
		for (let i = 0; i < GRAPH_PROJECTION_MANAGED_COUNT_QUICK_RETRIES; i++)
			counted.push(await tick(minute(6, i * 2)));
		for (const result of counted) {
			expect(result).toMatchObject({ inventories: 1, projectedReads: 1 });
			expect(result.state).toBe("catching_up");
			expect(result.reason).toBe("managed_count_parity_failed");
		}
		const last = counted.at(-1)!;
		expect(last.inspection.managedCounts.mismatches).toEqual([
			{ kind: "edges", canonicalCount: 1, projectedCount: 2, delta: 1 },
		]);
		expect(last.inspection.readiness?.edgeMismatchCount).toBe(1);

		// The rest of the hour: no inventory on either side, same verdict.
		for (let m = 6; m < 60; m += 2) {
			const result = await tick(minute(6, m));
			expect(result).toMatchObject({ inventories: 0, projectedReads: 0 });
			expect(result.reason).toBe(last.reason);
			expect(result.state).toBe(last.state);
			expect(result.inspection.managedCounts).toEqual(
				last.inspection.managedCounts,
			);
			expect(result.inspection.parityPasses).toBe(false);
			expect(result.inspection.readiness).toMatchObject({
				nodeMismatchCount: last.inspection.readiness?.nodeMismatchCount,
				edgeMismatchCount: 1,
				lastCertifiedAt: null,
			});
		}

		// A new hour counts once more, then reuses again.
		expect(await tick(minute(7, 0))).toMatchObject({
			inventories: 1,
			projectedReads: 1,
			reason: "managed_count_parity_failed",
		});
		expect(await tick(minute(7, 2))).toMatchObject({
			inventories: 0,
			projectedReads: 0,
			reason: "managed_count_parity_failed",
		});

		// An operator's check and certification still count every time.
		const inspected = await inspectGraphProjection({
			db,
			env,
			organizationId: ORG,
			checkedAt: minute(7, 3),
		});
		expect(inspected.managedCountCheck.source).toBe("counted");
		expect(await tick(minute(7, 4), "exact")).toMatchObject({
			inventories: 1,
			projectedReads: 1,
		});

		// Parity restored: the next hour's count certifies and clears the record.
		graph.projected = canonical;
		expect(await tick(minute(7, 6))).toMatchObject({
			inventories: 0,
			reason: "managed_count_parity_failed",
		});
		const ready = await tick(minute(8, 0));
		expect(ready).toMatchObject({
			inventories: 1,
			projectedReads: 1,
			state: "ready",
			reason: null,
		});
		expect(ready.inspection.readiness).toMatchObject({
			nodeMismatchCount: 0,
			edgeMismatchCount: 0,
			lastCertifiedAt: minute(8, 0),
		});
		expect(await getGraphProjectionManagedCountAttempt(db, ORG)).toBeNull();
		// Certified this hour: no count, as before.
		expect(await tick(minute(8, 2))).toMatchObject({
			inventories: 0,
			projectedReads: 0,
			state: "ready",
		});
	});

	it("recovers on the next tick when a single count did not certify", async () => {
		vi.useFakeTimers();
		const { db, canonical, tick } = await fixture();
		graph.projected = { ...canonical, facts: canonical.facts - 1 };
		expect(await tick(minute(9, 0))).toMatchObject({
			inventories: 1,
			state: "catching_up",
			reason: "managed_count_parity_failed",
		});
		expect(await getGraphProjectionManagedCountAttempt(db, ORG)).toMatchObject({
			attempts: 1,
			checkedAt: minute(9, 0),
			compared: true,
		});
		graph.projected = canonical;
		expect(await tick(minute(9, 2))).toMatchObject({
			inventories: 1,
			state: "ready",
			reason: null,
		});
		expect((await getGraphProjectionReadState(db, ORG))?.lastCertifiedAt).toBe(
			minute(9, 2),
		);
		expect(await getGraphProjectionManagedCountAttempt(db, ORG)).toBeNull();
	});

	it("does not treat a projection it could not read as compared", async () => {
		vi.useFakeTimers();
		const { db, canonical, tick } = await fixture();
		graph.projected = canonical;
		graph.readable = false;
		for (let i = 0; i < GRAPH_PROJECTION_MANAGED_COUNT_QUICK_RETRIES; i++)
			expect(await tick(minute(10, i * 2))).toMatchObject({
				inventories: 1,
				state: "catching_up",
			});
		expect(await getGraphProjectionManagedCountAttempt(db, ORG)).toMatchObject({
			attempts: GRAPH_PROJECTION_MANAGED_COUNT_QUICK_RETRIES,
			compared: false,
		});
		// Readable again, but the stored counts were never compared: the gate
		// stays closed until the next hour's count.
		graph.readable = true;
		const reused = await tick(minute(10, 30));
		expect(reused).toMatchObject({ inventories: 0, state: "catching_up" });
		expect(reused.inspection.managedCounts.passesGate).toBe(false);
		expect(await tick(minute(11, 0))).toMatchObject({
			inventories: 1,
			state: "ready",
		});
	});

	it("skips the inventory while the graph database is unreachable", async () => {
		vi.useFakeTimers();
		const { db, canonical, tick } = await fixture();
		graph.projected = canonical;
		graph.healthy = false;
		const down = await tick(minute(12, 0));
		expect(down).toMatchObject({
			inventories: 0,
			projectedReads: 0,
			state: "degraded",
		});
		expect(down.reason).toContain("neo4j_unreachable");
		expect(down.reason).toContain("managed_count_parity_failed");
		expect(await getGraphProjectionManagedCountAttempt(db, ORG)).toBeNull();
		graph.healthy = true;
		expect(await tick(minute(12, 2))).toMatchObject({
			inventories: 1,
			state: "ready",
		});
	});
});
