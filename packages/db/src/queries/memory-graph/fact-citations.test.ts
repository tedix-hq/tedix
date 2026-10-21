import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { memoryFacts } from "../../schema/memory-graph";
import { createD1Facade, type SyncSqliteDatabase } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	backfillFactCitations,
	findCitationDependents,
} from "./fact-citations";

const ORG = "fictional-grove";
const migration = readFileSync(
	new URL(
		"../../../drizzle/20261022001402_memory-fact-citations/migration.sql",
		import.meta.url,
	),
	"utf8",
);
function fixture(
	onPrepare?: (query: string, sqlite: SyncSqliteDatabase) => void,
) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(memoryFacts));
	sqlite.exec(migration);
	const db = createDbQueryClient(
		createD1Facade(sqlite, { maxBoundParams: 100, onPrepare }),
	);
	const add = (
		id: string,
		citations: unknown,
		orgId = ORG,
		source = "consolidation://observation",
	) => {
		sqlite
			.prepare(
				"INSERT INTO memory_facts(id,organization_id,content,fact_type,source,metadata) VALUES (?,?,'Fictional evidence','pattern',?,?)",
			)
			.run(
				id,
				orgId,
				source,
				JSON.stringify({ consolidation: { evidence: { sources: citations } } }),
			);
	};
	const legacy = () => sqlite.exec("DELETE FROM memory_fact_citations");
	const links = () =>
		sqlite
			.prepare(
				"SELECT organization_id, consolidated_fact_id, cited_fact_id FROM memory_fact_citations ORDER BY consolidated_fact_id,cited_fact_id",
			)
			.all();
	return { sqlite, db, add, legacy, links };
}

describe("indexed memory fact citations", () => {
	it("atomically inserts, replaces, removes and deletes links for every metadata writer", async () => {
		const { sqlite, db, add, links } = fixture();
		add("head", [{ id: "a" }, { id: "a" }, { id: "b" }]);
		expect(links()).toHaveLength(2);
		await db.batch([
			db.update(memoryFacts).set({
				metadata: { consolidation: { evidence: { sources: [{ id: "c" }] } } },
			}),
		]);
		expect(links()).toEqual([
			{
				organization_id: ORG,
				consolidated_fact_id: "head",
				cited_fact_id: "c",
			},
		]);
		sqlite
			.prepare("UPDATE memory_facts SET organization_id=? WHERE id='head'")
			.run("fictional-other");
		expect(await findCitationDependents(db, ORG, ["c"])).toEqual([]);
		expect(await findCitationDependents(db, "fictional-other", ["c"])).toEqual([
			"head",
		]);
		sqlite.exec("UPDATE memory_facts SET metadata='{}' WHERE id='head'");
		expect(links()).toEqual([]);
		add("history", [{ id: "a" }]);
		sqlite.exec("DELETE FROM memory_facts WHERE id='history'");
		expect(links()).toEqual([]);
	});

	it("does not roll back canonical writes for malformed citation shapes", async () => {
		const { db, add, links, legacy } = fixture();
		for (const [i, sources] of [
			null,
			"text",
			1,
			{},
			["text", 1, null, {}, { id: 4 }, { id: "valid" }],
		].entries())
			add(`shape-${i}`, sources);
		expect(links()).toEqual([
			{
				organization_id: ORG,
				consolidated_fact_id: "shape-4",
				cited_fact_id: "valid",
			},
		]);
		expect(await findCitationDependents(db, ORG, ["valid"])).toEqual([
			"shape-4",
		]);
		const expected = links();
		legacy();
		await backfillFactCitations(db, ORG);
		expect(links()).toEqual(expected);
	});

	it("drains at most 100 facts per tick, survives a new client, and remains idempotent", async () => {
		const { sqlite, db, add, legacy, links } = fixture();
		for (let i = 0; i < 205; i++)
			add(`fact-${String(i).padStart(3, "0")}`, [{ id: "a" }, { id: "b" }]);
		add("summary", [{ id: "a" }], ORG, "consolidation://standing_summary");
		add("empty", []);
		add("other", [{ id: "a" }], "fictional-other");
		legacy();
		const before = (await findCitationDependents(db, ORG, ["a"])).sort();
		expect(before).toHaveLength(206);
		expect(await backfillFactCitations(db, ORG, 5000)).toBe(100);
		expect(links()).toHaveLength(198); // empty evidence advances the cursor too.
		const resumed = createDbQueryClient(
			createD1Facade(sqlite, { maxBoundParams: 100 }),
		);
		expect(await backfillFactCitations(resumed, ORG)).toBe(100);
		expect(await backfillFactCitations(resumed, ORG)).toBe(7);
		const after = links();
		expect(await backfillFactCitations(db, ORG)).toBe(0);
		expect(links()).toEqual(after);
		expect((await findCitationDependents(db, ORG, ["a"])).sort()).toEqual(
			before,
		);
		expect(after).toHaveLength(411);
		expect(await findCitationDependents(db, "fictional-other", ["a"])).toEqual([
			"other",
		]);
		// New facts behind the completed cursor are write-through indexed.
		add("aaa-new", [{ id: "a" }]);
		expect(await findCitationDependents(db, ORG, ["a"])).toContain("aaa-new");
	});

	it("preserves existing link timestamps when a backfill page is replayed", async () => {
		const { sqlite, db, add } = fixture();
		add("head", [{ id: "a" }]);
		sqlite.exec(
			"UPDATE memory_fact_citations SET created_at='2000-01-01T00:00:00Z'",
		);
		await backfillFactCitations(db, ORG);
		sqlite.exec("DELETE FROM memory_fact_citation_backfills");
		await backfillFactCitations(db, ORG);
		expect(
			sqlite.prepare("SELECT created_at FROM memory_fact_citations").get(),
		).toEqual({ created_at: "2000-01-01T00:00:00Z" });
	});

	it("replays a failed batch without advancing its durable cursor", async () => {
		const { sqlite, db, add, legacy, links } = fixture();
		add("head", [{ id: "a" }]);
		legacy();
		sqlite.exec(
			"CREATE TRIGGER fixture_abort_cursor BEFORE INSERT ON memory_fact_citation_backfills BEGIN SELECT RAISE(ABORT, 'fixture interruption'); END",
		);
		await expect(backfillFactCitations(db, ORG)).rejects.toThrow();
		expect(
			sqlite.prepare("SELECT * FROM memory_fact_citation_backfills").all(),
		).toEqual([]);
		expect(links()).toEqual([]);
		sqlite.exec("DROP TRIGGER fixture_abort_cursor");
		expect(await backfillFactCitations(db, ORG)).toBe(1);
		expect(links()).toHaveLength(1);
		expect(await backfillFactCitations(db, ORG)).toBe(0);
	});

	it("backfills persisted metadata when a concurrent replacement wins after selection", async () => {
		let replace = false;
		const { db, add, legacy, links } = fixture((query, sqlite) => {
			if (
				replace &&
				query.startsWith("INSERT OR IGNORE INTO memory_fact_citations")
			) {
				replace = false;
				sqlite
					.prepare("UPDATE memory_facts SET metadata=? WHERE id='head'")
					.run(
						JSON.stringify({
							consolidation: { evidence: { sources: [{ id: "winner" }] } },
						}),
					);
			}
		});
		add("head", [{ id: "stale" }]);
		legacy();
		replace = true;
		expect(await backfillFactCitations(db, ORG)).toBe(1);
		expect(links()).toEqual([
			{
				organization_id: ORG,
				consolidated_fact_id: "head",
				cited_fact_id: "winner",
			},
		]);
	});

	it("never regresses a cursor advanced by a concurrent tick", async () => {
		let advance = false;
		const { sqlite, db, add, legacy } = fixture((query, sqlite) => {
			if (
				!advance ||
				!query.startsWith("INSERT OR IGNORE INTO memory_fact_citations")
			)
				return;
			advance = false;
			sqlite
				.prepare(
					"INSERT INTO memory_fact_citation_backfills(organization_id,source,fact_id,done) VALUES (?,?,?,1)",
				)
				.run(ORG, "consolidation://standing_summary", "newer");
		});
		add("head", [{ id: "a" }]);
		legacy();
		advance = true;
		await backfillFactCitations(db, ORG, 1);
		expect(
			sqlite
				.prepare(
					"SELECT source,fact_id,done FROM memory_fact_citation_backfills",
				)
				.get(),
		).toEqual({
			source: "consolidation://standing_summary",
			fact_id: "newer",
			done: 1,
		});
	});

	it("retains dependents when backfill moves a page to links between recall reads", async () => {
		let race = false;
		const { db, add, legacy } = fixture((query, sqlite) => {
			if (!race || !query.includes("citation.value")) return;
			race = false;
			sqlite
				.prepare(
					"INSERT INTO memory_fact_citations(organization_id,cited_fact_id,consolidated_fact_id) VALUES (?,?,?)",
				)
				.run(ORG, "a", "head");
			sqlite
				.prepare(
					"INSERT INTO memory_fact_citation_backfills(organization_id,source,fact_id,done) VALUES (?,?,?,1)",
				)
				.run(ORG, "consolidation://standing_summary", "head");
		});
		add("head", [{ id: "a" }]);
		legacy();
		race = true;
		expect(await findCitationDependents(db, ORG, ["a"])).toEqual(["head"]);
	});

	it("uses index SEARCH for linked and legacy pages, with JSON parsed only for bounded missing-link pages", async () => {
		const plans: string[] = [];
		const queries: string[] = [];
		const { db, add, legacy } = fixture((query, sqlite) => {
			if (!/^SELECT/i.test(query)) return;
			queries.push(query);
			plans.push(
				...(
					sqlite
						.prepare(`EXPLAIN QUERY PLAN ${query}`)
						.all(
							...Array((query.match(/\?/g) ?? []).length).fill(null),
						) as Array<{ detail: string }>
				).map((row) => row.detail),
			);
		});
		for (let i = 0; i < 205; i++)
			add(`head-${String(i).padStart(3, "0")}`, [{ id: "a" }]);
		legacy();
		expect(await findCitationDependents(db, ORG, ["a"])).toHaveLength(205);
		expect(
			queries.filter((query) => query.includes("citation.value")),
		).toHaveLength(3);
		expect(
			plans.some((detail) =>
				/SEARCH memory_fact_citations USING INDEX idx_memory_fact_citations_org_cited/.test(
					detail,
				),
			),
		).toBe(true);
		expect(
			plans.some((detail) =>
				/SEARCH memory_facts USING INDEX idx_memory_facts_source/.test(detail),
			),
		).toBe(true);
		expect(
			plans.some((detail) =>
				/SEARCH memory_facts USING INDEX sqlite_autoindex_memory_facts_1/.test(
					detail,
				),
			),
		).toBe(true);
		expect(
			plans.some((detail) => /SCAN (?:memory_facts|f)\b/.test(detail)),
		).toBe(false);
		while (await backfillFactCitations(db, ORG)) {}
		queries.length = 0;
		expect(await findCitationDependents(db, ORG, ["a"])).toHaveLength(205);
		expect(queries.some((query) => query.includes("citation.value"))).toBe(
			false,
		);
	});
});
