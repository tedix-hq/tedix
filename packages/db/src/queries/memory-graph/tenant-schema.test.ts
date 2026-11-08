import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { tenantStoreMigrations } from "../../tenant-store/migrations";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { queryMemory, type MemoryQueryConfig } from "./tenant-rpc";
import { SearchResultSchema } from "@tedix/api-contract/schemas/memory-graph";
import { createFact, findCurrentFactsByTopicKey } from "./facts";
import { hydrateRecall, lexicalRecall, temporalRecall } from "./hybrid-recall";
import { findCitationDependents } from "./fact-citations";

const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function tenant() {
	const db = new DatabaseSync(":memory:");
	databases.push(db);
	db.exec("PRAGMA foreign_keys=ON");
	for (const migration of Object.values(tenantStoreMigrations))
		db.exec(migration);
	return db;
}
const memoryTables = [
	"memory_domains",
	"tedi_expertise",
	"tedi_curiosity_queue",
	"tedi_optimization_signals",
	"memory_facts",
	"memory_edges",
	"memory_entities",
	"memory_entity_mentions",
	"memory_entity_aliases",
	"memory_entity_resolution_heads",
	"memory_entity_resolution_decisions",
	"memory_entity_resolutions",
	"memory_fact_citations",
	"memory_fact_citation_backfills",
	"graph_projection_outbox",
];

describe("workspace memory migration contract", () => {
	it("retains stored policies and per-tedi recall after copying unchanged rows into the real tenant schema", async () => {
		const platform = createMigratedSqlite({ foreignKeys: false });
		databases.push(platform);
		const local = tenant();
		local.exec(
			"INSERT INTO tenant_store_identity VALUES (1,'fictional-org','physical-home','2026-11-08')",
		);
		const source = createDbClient(createD1Facade(platform));
		const target = createDbClient(createD1Facade(local));
		const organizationId = "fictional-org";
		const now = "2026-11-08T12:00:00.000Z";
		for (const [id, visibility, tediId, usePolicy, memoryScope] of [
			["org", "org", "tedi-a", "can_use_as_evidence", "org"],
			["shared", "shared", "tedi-a", "can_use_as_instruction", "tedi"],
			["private-a", "private", "tedi-a", "requires_user_confirmation", "tedi"],
			["private-b", "private", "tedi-b", "can_use_as_evidence", "tedi"],
			["excluded", "org", "tedi-a", "do_not_inject_automatically", "org"],
		] as const) {
			await createFact(source, {
				id,
				organizationId,
				tediId,
				visibility,
				usePolicy,
				memoryScope,
				content: "Cobalt migration decision",
				factType: "decision",
				topicKey: "storage/cobalt",
				reviewStatus: "confirmed",
				validFrom: "2026-11-07T10:00:00.000Z",
				createdAt: "2026-11-07T10:00:00.000Z",
				source: id === "excluded" ? "consolidation://observation" : null,
				metadata:
					id === "excluded"
						? {
								consolidation: { evidence: { sources: [{ id: "org" }] } },
							}
						: null,
			});
		}
		const sourceRows = platform
			.prepare("SELECT * FROM memory_facts ORDER BY id")
			.all();
		for (const row of sourceRows) {
			const columns = Object.keys(row);
			local
				.prepare(
					`INSERT INTO memory_facts (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
				)
				.run(...Object.values(row));
		}
		expect(
			local.prepare("SELECT * FROM memory_facts ORDER BY id").all(),
		).toEqual(sourceRows);
		for (const db of [source, target]) {
			for (const [tediId, privateId] of [
				["tedi-a", "private-a"],
				["tedi-b", "private-b"],
				[undefined, undefined],
			] as const) {
				const scope = { organizationId, tediId, now };
				const expected = [
					"org",
					"shared",
					...(privateId ? [privateId] : []),
				].sort();
				const topicFacts = await findCurrentFactsByTopicKey(
					db,
					scope,
					"storage/cobalt",
				);
				const candidates = await lexicalRecall(db, scope, "cobalt migration");
				const temporal = await temporalRecall(
					db,
					scope,
					"what changed yesterday",
				);
				for (const ids of [
					candidates.map((row) => row.factId),
					temporal.map((row) => row.factId),
					topicFacts.map((row) => row.id),
				]) {
					const facts = await hydrateRecall(db, scope, ids);
					expect(facts.map((row) => row.id).sort()).toEqual(expected);
					for (const fact of facts)
						expect(
							SearchResultSchema.parse({ factId: fact.id, score: 1, fact })
								.factId,
						).toBe(fact.id);
				}
			}
			const foreign = {
				organizationId: "fictional-other",
				tediId: "tedi-a",
				now,
			};
			expect(await lexicalRecall(db, foreign, "cobalt migration")).toEqual([]);
			expect(
				await hydrateRecall(
					db,
					foreign,
					sourceRows.map((row) => String(row.id)),
				),
			).toEqual([]);
			expect(
				await findCitationDependents(db, { organizationId }, ["org"]),
			).toEqual(["excluded"]);
			expect(await findCitationDependents(db, foreign, ["org"])).toEqual([]);
		}
	});

	it("matches canonical columns, indexes, local foreign keys and all memory triggers/views", () => {
		const platform = createMigratedSqlite();
		const local = tenant();
		for (const table of memoryTables) {
			expect(
				local.prepare(`PRAGMA table_info('${table}')`).all(),
				table,
			).toEqual(platform.prepare(`PRAGMA table_info('${table}')`).all());
			const foreignKeys = (db: DatabaseSync) =>
				db
					.prepare(`PRAGMA foreign_key_list('${table}')`)
					.all()
					.filter(
						(row) => !["organizations", "tedis"].includes(String(row.table)),
					)
					.map(({ id: _id, ...row }) => row)
					.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
			expect(foreignKeys(local), table).toEqual(foreignKeys(platform));
			const indexes = (db: DatabaseSync) =>
				db
					.prepare(
						"SELECT name, sql FROM sqlite_schema WHERE type='index' AND tbl_name=? ORDER BY name",
					)
					.all(table);
			expect(indexes(local), table).toEqual(indexes(platform));
		}
		const canonical = platform
			.prepare(
				"SELECT name, sql FROM sqlite_schema WHERE (type='trigger' AND tbl_name LIKE 'memory_%') OR (type='view' AND name LIKE 'memory_fact_%') OR (type='table' AND name IN ('memory_fact_fts','memory_fact_fts_recall')) ORDER BY name",
			)
			.all();
		for (const row of canonical)
			expect(
				local
					.prepare("SELECT name, sql FROM sqlite_schema WHERE name=?")
					.get(row.name!),
				String(row.name),
			).toEqual(row);
		expect(local.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
	});

	it("rejects unbound/foreign organization rows and retains local FK and governance fences", () => {
		const db = tenant();
		const insert = db.prepare(
			"INSERT INTO memory_facts(id,organization_id,content,fact_type,domain_id) VALUES (?,?,?,?,?)",
		);
		expect(() =>
			insert.run("unbound", "fictional-org", "test", "technical", null),
		).toThrow("outside this workspace");
		db.exec(
			"INSERT INTO tenant_store_identity VALUES (1,'fictional-org','fictional-workspace','2026-11-06')",
		);
		expect(() =>
			insert.run("foreign", "fictional-other", "test", "technical", null),
		).toThrow("outside this workspace");
		expect(() =>
			insert.run(
				"dangling",
				"fictional-org",
				"test",
				"technical",
				"missing-domain",
			),
		).toThrow("FOREIGN KEY constraint");
		insert.run("valid", "fictional-org", "test", "technical", null);
		expect(() =>
			db.exec(
				"UPDATE memory_facts SET organization_id='fictional-other' WHERE id='valid'",
			),
		).toThrow();
		expect(() =>
			db.exec(
				"INSERT INTO memory_entity_resolutions(id,organization_id,mention_id,entity_id,decision_id,resolution_kind,confidence,valid_from) VALUES ('forged','fictional-org','missing','missing','missing','linked',0.9,'2026-11-06')",
			),
		).toThrow("acceptance fence failed");
	});

	it("records expertise mutations under the bound domain organization", () => {
		const db = tenant();
		db.exec(
			"INSERT INTO tenant_store_identity VALUES (1,'fictional-org','fictional-workspace','2026-11-06')",
		);
		expect(() =>
			db.exec(
				"INSERT INTO tedi_expertise(id,tedi_id,domain_id) VALUES ('bad','tedi-a','missing')",
			),
		).toThrow("outside this workspace");
		db.exec(
			"INSERT INTO memory_domains(id,organization_id,name) VALUES ('domain','fictional-org','migration')",
		);
		db.exec(
			"INSERT INTO tedi_expertise(id,tedi_id,domain_id) VALUES ('expertise','tedi-a','domain')",
		);
		db.exec("UPDATE tedi_expertise SET fact_count=2 WHERE id='expertise'");
		db.exec("DELETE FROM tedi_expertise WHERE id='expertise'");
		expect(
			db
				.prepare(
					"SELECT organization_id, operation FROM graph_projection_outbox WHERE entity_kind='tedi_expertise' ORDER BY sequence",
				)
				.all(),
		).toEqual([
			{ organization_id: "fictional-org", operation: "upsert" },
			{ organization_id: "fictional-org", operation: "upsert" },
			{ organization_id: "fictional-org", operation: "delete" },
		]);
	});

	it("uses explicit plane config and never falls back to D1 for an unbound tenant plane", async () => {
		const sqlite = createMigratedSqlite({ foreignKeys: false });
		const db = createDbClient(createD1Facade(sqlite));
		const scope = {
			organizationId: "fictional-org",
			workspaceId: "fictional-workspace",
		};
		const created = await queryMemory({ plane: "platform-d1", db }, scope, {
			operation: "createFact",
			input: {
				id: "platform",
				content: "Platform recall",
				factType: "technical",
			},
		});
		expect(created.id).toBe("platform");
		const missing = { plane: "do-local-sqlite", env: {} } as MemoryQueryConfig;
		await expect(
			queryMemory(missing, scope, {
				operation: "getFact",
				input: { factId: "platform" },
			}),
		).rejects.toThrow();
		expect(
			(
				await queryMemory({ plane: "platform-d1", db }, scope, {
					operation: "getFact",
					input: { factId: "platform" },
				})
			)?.id,
		).toBe("platform");
	});
});
