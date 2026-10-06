/**
 * `searchFactsWithVisibility` visibility semantics against a real SQLite
 * backing. The load-bearing case is the ABSENT `visibilityTediId`: that branch
 * used to apply no visibility condition at all, so any caller without a tedi
 * identity (org operator, API key, service) read every tedi's private facts.
 * The query now defaults that read to `visibility IN ('org','shared')` —
 * least privilege, mirroring `isMemorySearchFactEligible` in apps/api.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { memoryDomains, memoryFacts } from "../schema/memory-graph";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { searchFactsWithVisibility } from "./memory-graph/fact-search";

type FactSeed = {
	id: string;
	visibility?: "private" | "shared" | "org";
	tediId?: string | null;
	archivedAt?: string | null;
};

function seed(seeds: FactSeed[]) {
	const sqlite = new DatabaseSync(":memory:");
	// Visibility filtering is the subject here, not referential integrity;
	// `tedis` drags in a transitive FK closure that adds fixture noise only.
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(memoryDomains, memoryFacts));
	const insert = sqlite.prepare(`
		INSERT INTO memory_facts
			(id, organization_id, tedi_id, content, fact_type, confidence,
			 visibility, archived_at)
		VALUES (?, 'org-1', ?, ?, 'observation', 0.9, ?, ?)
	`);
	for (const fact of seeds) {
		insert.run(
			fact.id,
			fact.tediId ?? null,
			`content ${fact.id}`,
			fact.visibility ?? "private",
			fact.archivedAt ?? null,
		);
	}
	return createDbClient(createD1Facade(sqlite));
}

const ids = (rows: Array<{ id: string }>) => rows.map((row) => row.id).sort();

const FIXTURE: FactSeed[] = [
	{ id: "org-fact", visibility: "org", tediId: null },
	{ id: "shared-fact", visibility: "shared", tediId: "tedi-2" },
	{ id: "own-private", visibility: "private", tediId: "tedi-1" },
	{ id: "other-private", visibility: "private", tediId: "tedi-2" },
	{ id: "unowned-private", visibility: "private", tediId: null },
];

describe("searchFactsWithVisibility", () => {
	it("without a visibilityTediId returns only org and shared facts — never any tedi's private facts", async () => {
		const db = seed(FIXTURE);
		const rows = await searchFactsWithVisibility(db, { orgId: "org-1" });
		expect(ids(rows)).toEqual(["org-fact", "shared-fact"]);
	});

	it("with a visibilityTediId adds exactly that tedi's private facts", async () => {
		const db = seed(FIXTURE);
		const rows = await searchFactsWithVisibility(db, {
			orgId: "org-1",
			visibilityTediId: "tedi-1",
		});
		expect(ids(rows)).toEqual(["org-fact", "own-private", "shared-fact"]);
	});

	it("keeps the default archived exclusion alongside the visibility default", async () => {
		const db = seed([
			...FIXTURE,
			{ id: "archived-org", visibility: "org", archivedAt: "2026-06-16" },
		]);
		const rows = await searchFactsWithVisibility(db, { orgId: "org-1" });
		expect(ids(rows)).toEqual(["org-fact", "shared-fact"]);
	});
});
