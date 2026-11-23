import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { memoryFacts, tediExpertise } from "../schema/memory-graph";
import { tediRationaleRecords } from "../schema/rationale-records";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { recalculateExpertise } from "./memory-graph/expertise";
import { getRecentCompletedByCategory } from "./rationale-records";

it("seeks one live expertise slice and the latest completed category decisions", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec(
			schemaDdl(
				{ foreignKeys: false },
				memoryFacts,
				tediExpertise,
				tediRationaleRecords,
			),
		);
		const fact = sqlite.prepare(`INSERT INTO memory_facts
			(id, organization_id, tedi_id, domain_id, content, fact_type, confidence, archived_at)
			VALUES (?, ?, ?, ?, 'Example', 'technical', ?, ?)`);
		for (let i = 0; i < 27_000; i++)
			fact.run(
				`noise-${i}`,
				i % 2 ? "other-org" : "org",
				i % 3 ? "other-tedi" : "tedi",
				i % 5 ? "other-domain" : "domain",
				1,
				"2026-01-01",
			);
		fact.run("live-a", "org", "tedi", "domain", 0.4, null);
		fact.run("live-b", "org", "tedi", "domain", 0.8, null);
		fact.run("foreign", "other-org", "tedi", "domain", 1, null);
		fact.run("other-tedi", "org", "other-tedi", "domain", 1, null);
		fact.run("other-domain", "org", "tedi", "other-domain", 1, null);
		const rationale = sqlite.prepare(`INSERT INTO tedi_rationale_records
			(id, tedi_id, org_id, action, rationale, category, outcome_status, created_at)
			VALUES (?, ?, 'org', 'Review', 'Example', ?, ?, ?)`);
		for (let i = 0; i < 35_000; i++)
			rationale.run(
				`pending-${i}`,
				"tedi",
				i % 2 ? "category" : "other-category",
				"pending",
				"2026-11-23",
			);
		for (let i = 0; i < 8; i++)
			rationale.run(
				`completed-${i}`,
				"tedi",
				"category",
				i % 2 ? "failure" : "success",
				`2026-11-${10 + i}`,
			);
		rationale.run("unverified", "tedi", "category", "unverified", "2026-11-19");
		rationale.run(
			"other-tedi",
			"other-tedi",
			"category",
			"success",
			"2026-11-24",
		);
		rationale.run(
			"other-category",
			"tedi",
			"other-category",
			"success",
			"2026-11-24",
		);

		const plans: string[] = [];
		const db = createDbClient(
			createD1Facade({
				prepare(query) {
					if (
						/^select/i.test(query) &&
						(query.includes('"memory_facts"') ||
							query.includes('"tedi_rationale_records"'))
					)
						plans.push(
							...sqlite
								.prepare(`EXPLAIN QUERY PLAN ${query}`)
								.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
								.map((row) => String(row.detail)),
						);
					if (/^select/i.test(query) && query.includes('"memory_facts"')) {
						const rootPage = sqlite
							.prepare(
								"SELECT rootpage FROM sqlite_schema WHERE name = 'memory_facts'",
							)
							.get()!.rootpage;
						const bytecode = sqlite
							.prepare(`EXPLAIN ${query}`)
							.all(...Array((query.match(/\?/g) ?? []).length).fill(null));
						const tableCursors = bytecode
							.filter((row) => row.opcode === "OpenRead" && row.p2 === rootPage)
							.map((row) => row.p1);
						// Partial indexes may omit COVERING in the plan text; ensure the VM
						// never reads a table column (COUNT(id) would require one).
						expect(
							bytecode.filter(
								(row) =>
									row.opcode === "Column" && tableCursors.includes(row.p1),
							),
						).toEqual([]);
					}
					return sqlite.prepare(query);
				},
				exec: (query) => sqlite.exec(query),
			}),
		);
		// Check both the initial post-migration plan and the analysed database.
		for (const analysed of [false, true]) {
			if (analysed) sqlite.exec("ANALYZE");
			plans.length = 0;
			const expertise = await recalculateExpertise(
				db,
				{ organizationId: "org" },
				"tedi",
				"domain",
			);
			expect(expertise.factCount).toBe(2);
			expect(expertise.avgConfidence).toBeCloseTo(0.6);
			const records = await getRecentCompletedByCategory(
				db,
				"tedi",
				"category",
				5,
			);
			expect(records.map((row) => row.id)).toEqual([
				"unverified",
				"completed-7",
				"completed-6",
				"completed-5",
				"completed-4",
			]);
			const plan = plans.join("\n");
			expect(plan).toMatch(
				/SEARCH memory_facts USING (?:COVERING )?INDEX idx_memory_facts_expertise_live \(organization_id=\? AND tedi_id=\? AND domain_id=\?\)/,
			);
			expect(plan).toMatch(
				/SEARCH tedi_rationale_records USING INDEX idx_rationale_completed_category_created \(tedi_id=\? AND category=\?\)/,
			);
			expect(plan).not.toMatch(
				/SCAN (memory_facts|tedi_rationale_records)|USE TEMP B-TREE/,
			);
		}
	} finally {
		sqlite.close();
	}
});
