/**
 * `getTopPlatformFacts` runs on every Home turn, so it was rewritten from one
 * `CASE`-ranked query into one query per priority (see the query for why). These
 * tests pin the properties the rewrite had to preserve, against a real SQLite
 * backing rather than a hand-rolled stub: core outranks active regardless of
 * confidence, each group is ordered by confidence then recency, archived facts
 * and `background` priority stay excluded, and the tedi filter still admits
 * org-wide facts.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { memoryDomains, memoryFacts } from "../schema/memory-graph";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { getTopPlatformFacts } from "./memory-graph/platform-facts";

type FactSeed = {
	id: string;
	priority?: "core" | "active" | "background";
	confidence?: number;
	lastAccessedAt?: string | null;
	archivedAt?: string | null;
	tediId?: string | null;
};

function seed(seeds: FactSeed[]) {
	const sqlite = new DatabaseSync(":memory:");
	// These tests exercise ordering, not referential integrity, and `tedis`
	// drags in a transitive FK closure (workspace_template_sets, runtime
	// profiles, policy packs) that would add fixture noise without adding signal.
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(memoryDomains, memoryFacts));
	const insert = sqlite.prepare(`
		INSERT INTO memory_facts
			(id, organization_id, tedi_id, content, fact_type, confidence,
			 priority, last_accessed_at, archived_at)
		VALUES (?, 'org-1', ?, ?, 'observation', ?, ?, ?, ?)
	`);
	for (const fact of seeds) {
		insert.run(
			fact.id,
			fact.tediId ?? null,
			`content ${fact.id}`,
			fact.confidence ?? 0.5,
			fact.priority ?? "active",
			fact.lastAccessedAt ?? null,
			fact.archivedAt ?? null,
		);
	}
	return createDbClient(createD1Facade(sqlite));
}

const ids = (rows: Awaited<ReturnType<typeof getTopPlatformFacts>>) =>
	rows.map((row) => row.fact.id);

describe("getTopPlatformFacts", () => {
	it("ranks every core fact above every active fact, whatever the confidence", async () => {
		// The low-confidence core fact is the whole point: a naive "ORDER BY
		// confidence" rewrite would float the 0.99 active fact to the top.
		const db = seed([
			{ id: "active-high", priority: "active", confidence: 0.99 },
			{ id: "core-low", priority: "core", confidence: 0.1 },
			{ id: "core-high", priority: "core", confidence: 0.9 },
		]);

		expect(ids(await getTopPlatformFacts(db, "org-1"))).toEqual([
			"core-high",
			"core-low",
			"active-high",
		]);
	});

	it("breaks confidence ties on last-accessed, most recent first", async () => {
		const db = seed([
			{ id: "stale", confidence: 0.7, lastAccessedAt: "2026-01-01T00:00:00Z" },
			{ id: "fresh", confidence: 0.7, lastAccessedAt: "2026-07-01T00:00:00Z" },
		]);

		expect(ids(await getTopPlatformFacts(db, "org-1"))).toEqual([
			"fresh",
			"stale",
		]);
	});

	it("excludes archived facts and background priority", async () => {
		const db = seed([
			{ id: "keep", priority: "core", confidence: 0.5 },
			{ id: "archived", priority: "core", archivedAt: "2026-07-01T00:00:00Z" },
			{ id: "background", priority: "background", confidence: 0.99 },
		]);

		expect(ids(await getTopPlatformFacts(db, "org-1"))).toEqual(["keep"]);
	});

	it("applies the limit ACROSS both priorities, not per priority", async () => {
		// The split runs LIMIT n twice, so a missing final slice would return 2n.
		const db = seed([
			{ id: "core-a", priority: "core", confidence: 0.9 },
			{ id: "core-b", priority: "core", confidence: 0.8 },
			{ id: "active-a", priority: "active", confidence: 0.7 },
			{ id: "active-b", priority: "active", confidence: 0.6 },
		]);

		expect(ids(await getTopPlatformFacts(db, "org-1", { limit: 3 }))).toEqual([
			"core-a",
			"core-b",
			"active-a",
		]);
	});

	it("admits org-wide facts alongside the requested tedi's own", async () => {
		const db = seed([
			{ id: "mine", priority: "core", confidence: 0.9, tediId: "tedi-1" },
			{ id: "org-wide", priority: "core", confidence: 0.8, tediId: null },
			{ id: "theirs", priority: "core", confidence: 0.99, tediId: "tedi-2" },
		]);

		expect(
			ids(await getTopPlatformFacts(db, "org-1", { tediId: "tedi-1" })),
		).toEqual(["mine", "org-wide"]);
	});
});
