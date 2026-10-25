import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { memoryFacts } from "../schema/memory-graph";
import { memoryEntityMentions } from "../schema/memory-entities";
import { listRecentPeopleFacts } from "./memory-entities";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(memoryFacts, memoryEntityMentions));
	const fact = (id: string, org: string, updated: string) =>
		sqlite
			.prepare(
				"INSERT INTO memory_facts (id, organization_id, content, fact_type, updated_at) VALUES (?, ?, ?, 'observation', ?)",
			)
			.run(id, org, id, updated);
	const mention = (id: string, org: string, factId: string, type: string) =>
		sqlite
			.prepare(
				"INSERT INTO memory_entity_mentions (id, organization_id, occurrence_key, source_fact_id, surface_form, normalized_form, proposed_type, extractor, extractor_version, confidence, created_at) VALUES (?, ?, ?, ?, 'Ada', 'ada', ?, 'fixture', '1', 1, '2026-10-24T00:00:00Z')",
			)
			.run(id, org, id, factId, type);
	return { sqlite, db: createDbClient(createD1Facade(sqlite)), fact, mention };
}
describe("bounded people recall", () => {
	it("reads only this organization's recent facts with people mentions", async () => {
		const f = fixture();
		try {
			f.fact("person", "org-1", "2026-10-24T00:00:00Z");
			f.mention("m1", "org-1", "person", "person");
			f.fact("other-tenant", "org-2", "2026-10-25T00:00:00Z");
			f.mention("m2", "org-2", "other-tenant", "person");
			f.fact("old", "org-1", "2026-10-01T00:00:00Z");
			f.mention("m3", "org-1", "old", "person");
			f.fact("tool", "org-1", "2026-10-24T00:00:00Z");
			f.mention("m4", "org-1", "tool", "tool");
			f.fact("foreign-mention", "org-1", "2026-10-25T00:00:00Z");
			f.mention("m5", "org-2", "foreign-mention", "person");
			expect(
				(
					await listRecentPeopleFacts(f.db, {
						organizationId: "org-1",
						since: "2026-10-18T00:00:00Z",
					})
				).map((fact) => fact.id),
			).toEqual(["person"]);
		} finally {
			f.sqlite.close();
		}
	});
	it("limits the candidate pool before looking up mentions", async () => {
		const f = fixture();
		try {
			f.fact("outside-pool", "org-1", "2026-10-23T00:00:00Z");
			f.mention("person", "org-1", "outside-pool", "person");
			for (let i = 0; i < 50; i++)
				f.fact(`newer-${i}`, "org-1", "2026-10-24T00:00:00Z");
			expect(
				await listRecentPeopleFacts(f.db, {
					organizationId: "org-1",
					since: "2026-10-18T00:00:00Z",
				}),
			).toEqual([]);
		} finally {
			f.sqlite.close();
		}
	});
});
