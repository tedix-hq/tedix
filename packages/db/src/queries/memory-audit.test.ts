import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { memoryFacts } from "../schema/memory-graph";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { auditMemoryGraph } from "./memory-audit";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(memoryFacts));
	const insert = sqlite.prepare(
		`INSERT INTO memory_facts (id, organization_id, tedi_id, content, summary, fact_type, source)
		 VALUES (?, 'org-1', 'tedi-1', ?, ?, 'knowledge', ?)`,
	);
	return {
		deps: {
			db: createD1Facade(sqlite),
			organizationId: "org-1",
			tediId: "tedi-1",
		},
		insert: (
			id: string,
			content: string,
			summary: string | null,
			source: string | null,
		) => insert.run(id, content, summary, source),
	};
}

// The LIKEs these replaced turned any 48+ character search or source prefix
// into a D1_ERROR.
describe("auditMemoryGraph beyond D1's 50-byte LIKE pattern cap", () => {
	it("matches a long search against content or summary", async () => {
		const { deps, insert } = fixture();
		const needle =
			"The Northwind credential for the Fabrikam workspace rotates every ninety days";
		insert("content", needle, null, null);
		insert("summary", "other", needle.toUpperCase(), null);
		insert("miss", "The Northwind credential", "rotates", null);

		const result = await auditMemoryGraph(deps, { search: needle });
		expect(result.facts.map((fact) => fact.id).sort()).toEqual([
			"content",
			"summary",
		]);
	});

	it("matches a long source prefix", async () => {
		const { deps, insert } = fixture();
		const prefix =
			"skill://org/fabrikam/receivables-reconciliation/runs/2026-10-11/epoch-3";
		insert("hit", "a", null, `${prefix}/step-1`);
		insert("miss", "b", null, `other://${prefix}`);

		const result = await auditMemoryGraph(deps, { source_prefix: prefix });
		expect(result.facts.map((fact) => fact.id)).toEqual(["hit"]);
	});
});
