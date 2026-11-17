import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { findFactBySourceHash, getFactById } from "./facts";
import { searchFacts } from "./fact-search";

const SOURCE_HASH = "idx_memory_facts_org_source_hash";
const ORG = "org-example";

function fixture(statistics: "none" | "production-like" | "analysed") {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const insert = sqlite.prepare(
		"INSERT INTO memory_facts (id, organization_id, content, fact_type, confidence, valid_to, last_accessed_at, archived_at, source_hash, created_at) VALUES (?, ?, 'Example', 'technical', ?, ?, ?, ?, ?, ?)",
	);
	// Most facts carry no hash; a few hundred carry their own.
	for (let i = 0; i < 600; i++)
		insert.run(
			`plain-${i}`,
			i % 5 === 0 ? "org-other" : ORG,
			0.3 + (i % 7) / 10,
			i % 11 === 0 ? "2026-11-01T00:00:00Z" : null,
			null,
			i % 13 === 0 ? "2026-11-02T00:00:00Z" : null,
			i % 3 === 0 ? `hash-${i}` : null,
			`2026-10-${String(1 + (i % 28)).padStart(2, "0")}T00:00:00Z`,
		);
	// Several facts with one hash, inserted out of order: archived, ended,
	// tied on every ranked column, and the same hash in another organization.
	for (const [id, org, confidence, validTo, accessed, archived, created] of [
		["dup-high", ORG, 0.9, null, null, null, "2026-10-01T00:00:00Z"],
		["dup-ended", ORG, 0.1, "2026-11-01T00:00:00Z", null, null, "2026-10-01"],
		["dup-archived", ORG, 0.1, null, null, "2026-11-01T00:00:00Z", "2026-10"],
		["dup-accessed", ORG, 0.4, null, "2026-11-03T00:00:00Z", null, "2026-10"],
		["dup-late", ORG, 0.4, null, null, null, "2026-10-09T00:00:00Z"],
		["dup-tie-b", ORG, 0.4, null, null, null, "2026-10-02T00:00:00Z"],
		["dup-tie-a", ORG, 0.4, null, null, null, "2026-10-02T00:00:00Z"],
		["dup-foreign", "org-other", 0.01, null, null, null, "2026-10-01"],
	] as const)
		insert.run(
			id,
			org,
			confidence,
			validTo,
			accessed,
			archived,
			"dup",
			created,
		);
	insert.run("only-archived", ORG, 0.5, null, null, "2026-11-01", "gone", "x");
	if (statistics === "analysed") sqlite.exec("ANALYZE; ANALYZE sqlite_schema;");
	// The table as the planner saw it in November 2026: one organization
	// holding most facts, nearly all live. The new index has no row until the
	// database is analysed again, the state right after the migration.
	if (statistics === "production-like")
		sqlite.exec(`ANALYZE;
			DELETE FROM sqlite_stat1 WHERE tbl = 'memory_facts';
			INSERT INTO sqlite_stat1(tbl,idx,stat) VALUES
				('memory_facts','sqlite_autoindex_memory_facts_1','95000 1'),
				('memory_facts','idx_memory_facts_org_live_rank','95000 2400 2100 2000 40 3 1'),
				('memory_facts','idx_memory_facts_org_type_rank','95000 2400 400 350 330 12 2 1'),
				('memory_facts','idx_memory_facts_priority_rank','95000 2400 1200 1100 30 2'),
				('memory_facts','idx_memory_facts_org_source_id','95000 2400 3 1'),
				('memory_facts','idx_memory_facts_topic_key','95000 2400 2'),
				('memory_facts','idx_memory_facts_scope','95000 2400 800'),
				('memory_facts','idx_memory_facts_org_domain','95000 2400 60'),
				('memory_facts','idx_memory_facts_flywheel_updated','95000 2400 1');
			ANALYZE sqlite_schema;`);
	const plans: string[] = [];
	const explain = (query: string) =>
		sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
			.map((row) => String(row.detail))
			.join(" | ");
	const db = createDbClient(
		createD1Facade({
			prepare(query) {
				if (/^select/i.test(query) && query.includes('"memory_facts"'))
					plans.push(explain(query));
				return sqlite.prepare(query);
			},
			exec: (query) => sqlite.exec(query),
		}),
	);
	return { sqlite, db, plans, explain };
}

describe.each([
	{ statistics: "none" },
	{ statistics: "production-like" },
	{ statistics: "analysed" },
] as const)(
	"fact lookup by content hash with $statistics statistics",
	({ statistics }) => {
		it("seeks the hash instead of walking the organization's live facts", async () => {
			const { db, plans } = fixture(statistics);
			await findFactBySourceHash(db, { organizationId: ORG }, "dup");
			expect(plans).toEqual([
				`SEARCH memory_facts USING INDEX ${SOURCE_HASH} (organization_id=? AND source_hash=?) | USE TEMP B-TREE FOR ORDER BY`,
			]);
		});

		it("returns the fact the walk over live facts returned", async () => {
			const { sqlite, db } = fixture(statistics);
			// The statement as it ran before, on the index it ran on.
			const before = sqlite.prepare(
				"SELECT id FROM memory_facts INDEXED BY idx_memory_facts_org_live_rank WHERE organization_id = ? AND source_hash = ? AND archived_at IS NULL LIMIT 1",
			);
			const hashes = [
				"dup",
				"gone",
				"missing",
				...Array.from({ length: 200 }, (_, i) => `hash-${i * 3}`),
			];
			for (const organizationId of [ORG, "org-other", "org-none"])
				for (const hash of hashes)
					expect(
						(await findFactBySourceHash(db, { organizationId }, hash))?.id,
						`${organizationId} ${hash}`,
					).toBe(before.get(organizationId, hash)?.id);
			// Lowest confidence among the live ones, then never accessed, oldest,
			// first stored; never an archived fact or another organization's.
			const found = await findFactBySourceHash(
				db,
				{ organizationId: ORG },
				"dup",
			);
			expect(found?.id).toBe("dup-tie-b");
			expect(found).toEqual(
				await getFactById(db, { organizationId: ORG }, "dup-tie-b"),
			);
			expect(
				await findFactBySourceHash(db, { organizationId: ORG }, "gone"),
			).toBeUndefined();
		});

		it("is not offered to reads that do not name a hash", async () => {
			const { db, plans, explain } = fixture(statistics);
			// SQLite refuses a partial index whose condition the query does not
			// imply, so this cannot change with the statistics.
			for (const query of [
				"SELECT id FROM memory_facts INDEXED BY idx_memory_facts_org_source_hash WHERE organization_id = ?",
				"SELECT count(*) FROM memory_facts INDEXED BY idx_memory_facts_org_source_hash WHERE organization_id = ? AND archived_at IS NULL AND valid_to IS NULL",
				"SELECT id FROM memory_facts INDEXED BY idx_memory_facts_org_source_hash WHERE organization_id = ? AND source = ? ORDER BY id",
			])
				expect(() => explain(query)).toThrow(/no query solution/);
			await searchFacts(db, { organizationId: ORG, limit: 10 });
			await getFactById(db, { organizationId: ORG }, "dup-high");
			expect(plans.length).toBeGreaterThan(0);
			for (const plan of plans) expect(plan).not.toContain(SOURCE_HASH);
		});
	},
);
