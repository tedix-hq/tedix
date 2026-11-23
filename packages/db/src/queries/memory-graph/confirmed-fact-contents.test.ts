import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { memoryDomains, memoryFacts } from "../../schema/memory-graph";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { listConfirmedOrgFactContents } from "./fact-search";

it("reads only confirmed, active, org-visible facts through an index seek", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec("PRAGMA foreign_keys=OFF");
		for (const table of [memoryDomains, memoryFacts])
			sqlite.exec(schemaDdl(table));
		let query = "";
		const db = createDbQueryClient(
			createD1Facade(sqlite, {
				onPrepare: (statement) => {
					query = statement;
				},
			}),
		);
		const fact = (
			id: string,
			overrides: Partial<typeof memoryFacts.$inferInsert> = {},
		) =>
			db.insert(memoryFacts).values({
				id,
				organizationId: "org-example",
				content: id,
				factType: "lesson",
				reviewStatus: "confirmed",
				status: "active",
				visibility: "org",
				...overrides,
			} as typeof memoryFacts.$inferInsert);
		await fact("kept");
		await fact("shared", { visibility: "shared" });
		await fact("pending", { reviewStatus: "pending" });
		await fact("archived", { archivedAt: "2026-11-01T00:00:00Z" });
		await fact("private", { visibility: "private" });
		await fact("graph", { memoryScope: "graph" });
		await fact("foreign", { organizationId: "other-org" });
		const contents = await listConfirmedOrgFactContents(db, {
			organizationId: "org-example",
		});
		expect(contents.sort()).toEqual(["kept", "shared"]);
		const params = Array.from(
			{ length: (query.match(/\?/g) ?? []).length },
			() => "org-example",
		);
		const plan = sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...params)
			.map((row) => String(row.detail))
			.join(" | ");
		// Either the confirmed-lessons partial index or the visibility index whose
		// seek includes review_status; never the whole organization.
		expect(plan).toMatch(
			/idx_memory_facts_org_confirmed_lessons|review_status=\?/,
		);
		expect(plan).not.toMatch(/SCAN memory_facts\b/);
	} finally {
		sqlite.close();
	}
});
