import { DatabaseSync } from "node:sqlite";
import { describe, it, expect } from "vite-plus/test";
import { schemaDdl } from "../test/schema-ddl";
import { memoryFacts, memoryEdges } from "../schema/memory-graph";
import { createD1Facade } from "../test/d1-facade";
import { createDbClient } from "../client";
import {
	listAutoLinkFacts,
	createAutoLinkEdge,
} from "./memory-graph/auto-linking";
function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys=OFF"); // Fixture isolates query predicates; referenced org/tedi/domain tables are outside this test.
	sqlite.exec(schemaDdl(memoryFacts, memoryEdges));
	const insert = sqlite.prepare(
		"INSERT INTO memory_facts(id,organization_id,domain_id,content,fact_type,visibility,tedi_id,memory_scope) VALUES (?,?,?,?,?,?,?,?)",
	);
	for (const [id, org, visibility, owner] of [
		["a", "org", "org", null],
		["b", "org", "shared", null],
		["private", "org", "private", "t1"],
		["foreign", "foreign", "org", null],
	] as const)
		insert.run(
			id,
			org,
			"domain",
			`Content ${id}`,
			"fact",
			visibility,
			owner,
			"org",
		);
	return { sqlite, db: createDbClient(createD1Facade(sqlite)) };
}
describe("canonical Jev graph storage boundaries", () => {
	it("uses least-privilege visibility and exact selections", async () => {
		const { sqlite, db } = fixture();
		try {
			expect(
				(await listAutoLinkFacts(db, { organizationId: "org" }))
					.map((f) => f.id)
					.sort(),
			).toEqual(["a", "b"]);
			expect(
				(await listAutoLinkFacts(db, { organizationId: "org", tediId: "t1" }))
					.map((f) => f.id)
					.sort(),
			).toEqual(["a", "b", "private"]);
			expect(
				await listAutoLinkFacts(db, {
					organizationId: "org",
					factIds: ["foreign"],
				}),
			).toEqual([]);
			sqlite.exec(
				"UPDATE memory_facts SET review_status='rejected' WHERE id='a';UPDATE memory_facts SET valid_to='2026-01-01' WHERE id='b'",
			);
			expect(await listAutoLinkFacts(db, { organizationId: "org" })).toEqual(
				[],
			);
		} finally {
			sqlite.close();
		}
	});
	it("writes only current eligible bytes, preserves lifecycle, and deduplicates reverse edges", async () => {
		const { sqlite, db } = fixture();
		try {
			const [a, b] = await listAutoLinkFacts(db, { organizationId: "org" });
			const input = {
				id: "edge",
				source: a!,
				target: b!,
				relationType: "supersedes" as const,
				context: "judgment",
			};
			expect(
				await createAutoLinkEdge(db, { organizationId: "org" }, input),
			).toBe(true);
			expect(
				await createAutoLinkEdge(
					db,
					{ organizationId: "org" },
					{ ...input, id: "reverse", source: b!, target: a! },
				),
			).toBe(false);
			expect(
				sqlite
					.prepare("SELECT valid_to FROM memory_facts WHERE id=?")
					.get(a!.id)?.valid_to,
			).toBeNull();
			sqlite.exec(
				"DELETE FROM memory_edges; UPDATE memory_facts SET content='changed' WHERE id='a'",
			);
			expect(
				await createAutoLinkEdge(
					db,
					{ organizationId: "org" },
					{ ...input, id: "stale" },
				),
			).toBe(false);
		} finally {
			sqlite.close();
		}
	});
	it("atomically caps both endpoints and cannot cross private/public scope", async () => {
		const { sqlite, db } = fixture();
		try {
			const facts = await listAutoLinkFacts(db, {
				organizationId: "org",
				tediId: "t1",
			});
			const a = facts.find((f) => f.id === "a")!,
				b = facts.find((f) => f.id === "b")!,
				privateFact = facts.find((f) => f.id === "private")!;
			const base = {
				id: "edge",
				source: a,
				target: b,
				relationType: "related_to" as const,
				context: "judgment",
			};
			expect(
				await createAutoLinkEdge(
					db,
					{ organizationId: "org", tediId: "t1" },
					{ ...base, target: privateFact },
				),
			).toBe(false);
			for (let i = 0; i < 20; i++)
				sqlite
					.prepare(
						"INSERT INTO memory_edges(id,source_fact_id,target_fact_id,relation_type) VALUES (?,?,?,?)",
					)
					.run(`e${i}`, `other${i}`, b.id, "related_to");
			expect(
				await createAutoLinkEdge(db, { organizationId: "org" }, base),
			).toBe(false);
			sqlite.exec("DELETE FROM memory_edges");
			for (let i = 0; i < 20; i++)
				sqlite
					.prepare(
						"INSERT INTO memory_edges(id,source_fact_id,target_fact_id,relation_type) VALUES (?,?,?,?)",
					)
					.run(`source${i}`, a.id, `other${i}`, "related_to");
			expect(
				await createAutoLinkEdge(db, { organizationId: "org" }, base),
			).toBe(false);
			sqlite.exec(
				"DELETE FROM memory_edges; UPDATE memory_facts SET review_status='rejected' WHERE id='b'",
			);
			expect(
				await createAutoLinkEdge(db, { organizationId: "org" }, base),
			).toBe(false);
		} finally {
			sqlite.close();
		}
	});
});
