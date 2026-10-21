import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createDbQueryClient } from "../query-client";
import { decisionEdges } from "../schema/decision-graph";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	getDecisionEdgeForProjection,
	upsertDecisionEdges,
} from "./decision-graph";
import {
	coalesceGraphProjectionEvents,
	hydrateCanonicalGraphProjectionRows,
	readGraphProjectionBatch,
} from "./graph-projection";

const ORG = "fictional-lighthouse";
const MIGRATION = new URL(
	"../../drizzle/20261021202611_decision_edges_graph_projection/migration.sql",
	import.meta.url,
);

function fixture(seedBeforeMigration = false) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(organizations, decisionEdges));
	// Same shape as the control-plane migration; created_at defaults in SQL.
	sqlite.exec(`
		CREATE TABLE graph_projection_outbox (
			sequence INTEGER PRIMARY KEY AUTOINCREMENT,
			event_id TEXT NOT NULL UNIQUE,
			organization_id TEXT NOT NULL,
			entity_kind TEXT NOT NULL,
			entity_id TEXT NOT NULL,
			operation TEXT NOT NULL,
			payload TEXT,
			schema_version INTEGER NOT NULL DEFAULT 1,
			attempt_count INTEGER NOT NULL DEFAULT 0,
			next_attempt_at TEXT,
			last_error TEXT,
			poisoned_at TEXT,
			created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);
	`);
	sqlite
		.prepare("INSERT INTO organizations(id,name,slug) VALUES(?,?,?)")
		.run(ORG, "Lighthouse", "lighthouse");
	if (seedBeforeMigration) {
		sqlite.exec(`INSERT INTO decision_edges
			(id, org_id, from_kind, from_id, kind, to_kind, to_id, source, occurred_at, created_at, updated_at)
			VALUES ('edge-old', '${ORG}', 'work_item', 'work-a', 'blocks', 'work_item', 'work-b', 'backfill',
				'2026-10-20T08:00:00.000Z', '2026-10-20T08:00:00.000Z', '2026-10-20T08:00:00.000Z')`);
	}
	for (const statement of readFileSync(MIGRATION, "utf8").split(
		"--> statement-breakpoint",
	)) {
		sqlite.exec(statement);
	}
	const d1 = createD1Facade(sqlite);
	return {
		sqlite,
		queries: createDbQueryClient(d1),
		db: createDbClient(d1),
	};
}

const blocks = {
	kind: "blocks" as const,
	from: { kind: "work_item" as const, id: "work-a" },
	to: { kind: "work_item" as const, id: "work-b" },
	source: "work",
	occurredAt: "2026-10-21T08:00:00.000Z",
};

describe("decision edge graph projection triggers", () => {
	it("seeds edges that existed before the triggers", async () => {
		const { db } = fixture(true);
		const events = await readGraphProjectionBatch(db, ORG, 0);
		expect(events).toEqual([
			expect.objectContaining({
				entityKind: "decision_edge",
				entityId: "edge-old",
				operation: "upsert",
				payload: expect.objectContaining({
					orgId: ORG,
					kind: "blocks",
					fromId: "work-a",
					toId: "work-b",
				}),
			}),
		]);
	});

	it("appends upserts, skips unchanged rewrites and tombstones deletes", async () => {
		const { db, queries, sqlite } = fixture();
		await upsertDecisionEdges(queries, ORG, [blocks]);
		// A rewrite that only refreshes source/updated_at is not a graph change.
		await upsertDecisionEdges(queries, ORG, [
			{ ...blocks, source: "backfill" },
		]);
		await upsertDecisionEdges(queries, ORG, [{ ...blocks, note: "Ship gate" }]);
		const id = (
			sqlite.prepare("SELECT id FROM decision_edges").get() as { id: string }
		).id;
		sqlite.prepare("DELETE FROM decision_edges WHERE id = ?").run(id);

		const events = await readGraphProjectionBatch(db, ORG, 0);
		expect(events.map((event) => event.operation)).toEqual([
			"upsert",
			"upsert",
			"delete",
		]);
		expect(events[2]?.payload).toEqual({
			id,
			orgId: ORG,
			kind: "blocks",
			fromKind: "work_item",
			fromId: "work-a",
			toKind: "work_item",
			toId: "work-b",
		});
		// Relation-ordered: a delete is never reordered ahead of its upserts.
		expect(
			coalesceGraphProjectionEvents(events).map((event) => event.sequence),
		).toEqual(events.map((event) => event.sequence));
	});

	it("hydrates the current canonical row inside the organization", async () => {
		const { db, queries } = fixture();
		await upsertDecisionEdges(queries, ORG, [blocks]);
		const [event] = await readGraphProjectionBatch(db, ORG, 0);
		const [row] = await hydrateCanonicalGraphProjectionRows(db, [event!]);
		expect(row).toMatchObject({ org_id: ORG, kind: "blocks", to_id: "work-b" });
		await expect(
			getDecisionEdgeForProjection(queries, {
				organizationId: "fictional-harbor",
				edgeId: event!.entityId,
			}),
		).resolves.toBeNull();
	});
});
