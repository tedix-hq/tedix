import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vite-plus/test";

const DB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_DIR = join(DB_ROOT, "drizzle");
const migrationNames = readdirSync(MIGRATIONS_DIR)
	.filter((name) => /^\d{14}_/.test(name))
	.sort();

function applyMigration(sqlite: DatabaseSync, name: string): void {
	const sql = readFileSync(
		join(MIGRATIONS_DIR, name, "migration.sql"),
		"utf8",
	).replaceAll("--> statement-breakpoint", "");
	sqlite.exec(sql);
}

function applyThrough(sqlite: DatabaseSync, finalPrefix: string): void {
	for (const name of migrationNames) {
		applyMigration(sqlite, name);
		if (name.startsWith(finalPrefix)) return;
	}
	throw new Error(`Migration prefix ${finalPrefix} was not found`);
}

function applyByPrefix(sqlite: DatabaseSync, prefix: string): void {
	const name = migrationNames.find((candidate) => candidate.startsWith(prefix));
	if (!name) throw new Error(`Migration prefix ${prefix} was not found`);
	applyMigration(sqlite, name);
}

describe("graph cognition migration", () => {
	it("applies the complete ledger to an empty SQLite database", () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = ON");
		for (const name of migrationNames) applyMigration(sqlite, name);

		const tables = sqlite
			.prepare(
				`SELECT name
				 FROM sqlite_master
				 WHERE type = 'table'
				   AND name IN (
					 'graph_retrieval_benchmark_suites',
					 'memory_entities',
					 'graph_projection_readiness'
				   )
				 ORDER BY name`,
			)
			.all()
			.map((row) => row.name);
		expect(tables).toEqual([
			"graph_projection_readiness",
			"graph_retrieval_benchmark_suites",
			"memory_entities",
		]);
	});

	it("upgrades projection v1 with tenant and relationship fences intact", () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = ON");
		applyThrough(sqlite, "20260727034647_");
		sqlite.exec(`
			INSERT INTO organizations (id, name, slug) VALUES
				('org-1', 'One', 'one'),
				('org-2', 'Two', 'two');
			INSERT INTO memory_facts
				(id, organization_id, content, fact_type)
			VALUES
				('fact-1', 'org-1', 'one', 'technical'),
				('fact-2', 'org-1', 'two', 'technical'),
				('fact-3', 'org-1', 'three', 'technical'),
				('fact-other', 'org-2', 'other', 'technical');
			INSERT INTO memory_edges
				(id, source_fact_id, target_fact_id, relation_type)
			VALUES
				('edge-1', 'fact-1', 'fact-2', 'related_to');
		`);

		applyByPrefix(sqlite, "20260727060440_");
		expect(
			sqlite
				.prepare(
					`SELECT state, reason, repair_phase
					 FROM graph_projection_readiness
					 WHERE organization_id = 'org-1'`,
				)
				.get(),
		).toEqual({
			state: "catching_up",
			reason: "governed_baseline_repair_required",
			repair_phase: null,
		});

		expect(() =>
			sqlite
				.prepare(
					`INSERT INTO memory_edges
						(id, source_fact_id, target_fact_id, relation_type)
					 VALUES ('cross-org', 'fact-1', 'fact-other', 'related_to')`,
				)
				.run(),
		).toThrow(/same organization/);

		sqlite.exec("DELETE FROM graph_projection_outbox");
		sqlite
			.prepare(
				`UPDATE memory_edges
				 SET target_fact_id = 'fact-3'
				 WHERE id = 'edge-1'`,
			)
			.run();
		const tupleEvents = sqlite
			.prepare(
				`SELECT operation, payload
				 FROM graph_projection_outbox
				 WHERE entity_kind = 'edge'
				 ORDER BY sequence`,
			)
			.all() as Array<{ operation: string; payload: string }>;
		expect(tupleEvents.map((event) => event.operation)).toEqual([
			"delete",
			"upsert",
		]);
		expect(JSON.parse(tupleEvents[0]!.payload)).toMatchObject({
			sourceFactId: "fact-1",
			targetFactId: "fact-2",
			relationType: "related_to",
		});

		sqlite
			.prepare(
				`INSERT INTO memory_entities
					(id, organization_id, entity_type, display_name, normalized_name)
				 VALUES ('entity-1', 'org-1', 'organization', 'Acme', 'acme')`,
			)
			.run();
		expect(
			sqlite
				.prepare(
					`SELECT operation
					 FROM graph_projection_outbox
					 WHERE entity_kind = 'entity' AND entity_id = 'entity-1'`,
				)
				.get(),
		).toEqual({ operation: "upsert" });

		const triggerNames = sqlite
			.prepare(
				`SELECT name
				 FROM sqlite_master
				 WHERE type = 'trigger'
				   AND name IN (
					 'graph_benchmark_case_no_update',
					 'memory_entity_resolution_acceptance_guard',
					 'graph_projection_memory_facts_incident_edges_delete'
				   )
				 ORDER BY name`,
			)
			.all()
			.map((row) => row.name);
		expect(triggerNames).toEqual([
			"graph_benchmark_case_no_update",
			"graph_projection_memory_facts_incident_edges_delete",
			"memory_entity_resolution_acceptance_guard",
		]);
	});
});
