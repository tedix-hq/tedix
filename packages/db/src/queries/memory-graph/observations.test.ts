import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { memoryFacts, memoryEdges } from "../../schema/memory-graph";
import {
	memoryEntities,
	memoryEntityMentions,
	memoryEntityResolutions,
} from "../../schema/memory-entities";
import { createD1Facade, type SyncSqliteDatabase } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { backfillFactCitations } from "./fact-citations";
import {
	consolidateMemory,
	listMemoryObservations,
	preferConsolidatedFacts,
	readConsolidation,
} from "./observations";
import { invalidateFact } from "./fact-lifecycle";
const ORG = "fictional-grove";
function fixture(
	onPrepare?: (query: string, sqlite: SyncSqliteDatabase) => void,
) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(
		schemaDdl(
			memoryFacts,
			memoryEdges,
			memoryEntities,
			memoryEntityMentions,
			memoryEntityResolutions,
		),
	);
	sqlite.exec(
		readFileSync(
			new URL(
				"../../../drizzle/20261022001402_memory-fact-citations/migration.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
	const db = createDbClient(
		createD1Facade(sqlite, { maxBoundParams: 100, onPrepare }),
	);
	const add = async (id: string) => {
		await db.insert(memoryFacts).values({
			id,
			organizationId: ORG,
			content: `Fictional ${id} evidence.`,
			factType: "technical",
			topicKey: "fixture-topic",
			reviewStatus: "confirmed",
			status: "active",
			visibility: "org",
			memoryScope: "org",
		});
	};
	const verifyLinks = async () => {
		const rows = await listMemoryObservations(db, ORG, {
			includeHistory: true,
		});
		for (const row of rows) {
			const links = sqlite
				.prepare(
					"SELECT cited_fact_id FROM memory_fact_citations WHERE consolidated_fact_id=? ORDER BY cited_fact_id",
				)
				.all(row.id) as Array<{ cited_fact_id: string }>;
			expect(links.map((link) => link.cited_fact_id)).toEqual(
				[
					...new Set(
						readConsolidation(row)?.evidence.sources.map((source) => source.id),
					),
				].sort(),
			);
		}
	};
	return { sqlite, db, add, verifyLinks };
}
describe("consolidation citation link parity", () => {
	it("keeps heads and immutable history in step when evidence is replaced and fully retracted", async () => {
		const { db, add, verifyLinks } = fixture();
		await add("a");
		await add("b");
		await consolidateMemory(db, ORG);
		await verifyLinks();
		await add("c");
		await consolidateMemory(db, ORG);
		await verifyLinks();
		await invalidateFact(db, "a");
		await verifyLinks();
		await invalidateFact(db, "b");
		await verifyLinks();
		await invalidateFact(db, "c");
		await verifyLinks();
	});
	it("returns identical recall results before, during and after bounded backfill", async () => {
		const { sqlite, db, add } = fixture();
		await add("a");
		await add("b");
		await consolidateMemory(db, ORG);
		const raw = (await db.select().from(memoryFacts)).filter(
			(row) => row.id === "a",
		);
		const indexed = await preferConsolidatedFacts(db, ORG, raw);
		sqlite.exec("DELETE FROM memory_fact_citations");
		expect(await preferConsolidatedFacts(db, ORG, raw)).toEqual(indexed);
		expect(await backfillFactCitations(db, ORG, 1)).toBe(1);
		expect(await preferConsolidatedFacts(db, ORG, raw)).toEqual(indexed);
		while (await backfillFactCitations(db, ORG, 1)) {}
		expect(await preferConsolidatedFacts(db, ORG, raw)).toEqual(indexed);
	});
	it("does not replace a winning head's links when a concurrent refresh loses its CAS", async () => {
		let compete = false;
		let winnerId = "";
		const { db, add, verifyLinks } = fixture((query, sqlite) => {
			if (!compete || !query.startsWith('update "memory_facts" set "id"'))
				return;
			compete = false;
			const row = sqlite
				.prepare(
					"SELECT id,metadata FROM memory_facts WHERE source='consolidation://observation' AND archived_at IS NULL",
				)
				.get() as { id: string; metadata: string };
			winnerId = row.id;
			const metadata = JSON.parse(row.metadata);
			metadata.consolidation.evidence.sources =
				metadata.consolidation.evidence.sources.filter(
					(source: { id: string }) => source.id === "b",
				);
			metadata.consolidation.evidence.supportCount = 1;
			metadata.consolidation.fingerprint = "fixture-concurrent-winner";
			sqlite
				.prepare("UPDATE memory_facts SET metadata=? WHERE id=?")
				.run(JSON.stringify(metadata), row.id);
		});
		await add("a");
		await add("b");
		await consolidateMemory(db, ORG);
		await add("c");
		compete = true;
		await consolidateMemory(db, ORG);
		expect(winnerId).not.toBe("");
		await verifyLinks();
	});
});
