import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbQueryClient } from "../../query-client";
import { skillEntries } from "../../schema/cognitive";
import {
	memoryDomains,
	memoryEdges,
	memoryFacts,
} from "../../schema/memory-graph";
import { tediRationaleRecords } from "../../schema/rationale-records";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	listPortableTediEdgesPage,
	listPortableTediDomainsPage,
	listPortableTediFactsPage,
	listPortableTediRationalePage,
	listPortableTediSkillsPage,
} from "./snapshot";

describe("portable tedi snapshot reads", () => {
	it("paginates exact tedi ownership and keeps graph edges closed", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec("PRAGMA foreign_keys=OFF");
			sqlite.exec(
				schemaDdl(
					memoryDomains,
					memoryFacts,
					memoryEdges,
					skillEntries,
					tediRationaleRecords,
				),
			);
			const insertDomain = sqlite.prepare(
				"INSERT INTO memory_domains(id,organization_id,name) VALUES (?,?,?)",
			);
			insertDomain.run("fact-domain", "org-a", "Facts");
			insertDomain.run("parent-domain", "org-a", "Engineering");
			sqlite
				.prepare("UPDATE memory_domains SET parent_id=? WHERE id=?")
				.run("parent-domain", "fact-domain");
			insertDomain.run("skill-domain", "org-a", "Skills");
			insertDomain.run("other-domain", "org-a", "Unrelated");
			insertDomain.run("foreign-domain", "org-b", "Foreign");
			const insertFact = sqlite.prepare(
				"INSERT INTO memory_facts(id,organization_id,tedi_id,domain_id,content,fact_type) VALUES (?,?,?,?,?,?)",
			);
			for (const [id, org, tedi] of [
				["a", "org-a", "tedi-a"],
				["b", "org-a", "tedi-a"],
				["c", "org-a", "tedi-b"],
				["d", "org-a", null],
				["e", "org-b", "tedi-a"],
			] as const) {
				insertFact.run(
					id,
					org,
					tedi,
					id === "a" ? "fact-domain" : null,
					`Fact ${id}`,
					"fact",
				);
			}
			const insertEdge = sqlite.prepare(
				"INSERT INTO memory_edges(id,source_fact_id,target_fact_id,relation_type) VALUES (?,?,?,?)",
			);
			insertEdge.run("owned", "a", "b", "related_to");
			insertEdge.run("other-tedi", "a", "c", "related_to");
			insertEdge.run("org-wide", "a", "d", "related_to");
			insertEdge.run("other-org", "a", "e", "related_to");
			sqlite
				.prepare(
					"INSERT INTO skill_entries(id,organization_id,tedi_id,domain_id,title,content) VALUES (?,?,?,?,?,?)",
				)
				.run("skill-a", "org-a", "tedi-a", "skill-domain", "A", "Procedure A");
			sqlite
				.prepare(
					"INSERT INTO skill_entries(id,organization_id,tedi_id,domain_id,title,content) VALUES (?,?,?,?,?,?)",
				)
				.run(
					"skill-shared",
					"org-a",
					null,
					"other-domain",
					"Shared",
					"Procedure shared",
				);
			sqlite
				.prepare(
					"INSERT INTO tedi_rationale_records(id,tedi_id,org_id,action,rationale,created_at) VALUES (?,?,?,?,?,?)",
				)
				.run("reason-a", "tedi-a", "org-a", "decide", "Because", "2026-09-28");
			const db = createDbQueryClient(createD1Facade(sqlite));

			const first = await listPortableTediFactsPage(db, "org-a", "tedi-a", {
				limit: 1,
			});
			expect(first.map((row) => row.id)).toEqual(["a"]);
			expect(
				(
					await listPortableTediFactsPage(db, "org-a", "tedi-a", {
						afterId: first[0]!.id,
					})
				).map((row) => row.id),
			).toEqual(["b"]);
			expect(
				(await listPortableTediDomainsPage(db, "org-a", "tedi-a")).map(
					(row) => row.id,
				),
			).toEqual(["fact-domain", "parent-domain", "skill-domain"]);
			expect(
				(await listPortableTediEdgesPage(db, "org-a", "tedi-a")).map(
					(row) => row.id,
				),
			).toEqual(["owned"]);
			expect(
				(await listPortableTediSkillsPage(db, "org-a", "tedi-a")).map(
					(row) => row.id,
				),
			).toEqual(["skill-a"]);
			expect(
				(await listPortableTediRationalePage(db, "org-a", "tedi-a")).map(
					(row) => row.id,
				),
			).toEqual(["reason-a"]);
		} finally {
			sqlite.close();
		}
	});
});
