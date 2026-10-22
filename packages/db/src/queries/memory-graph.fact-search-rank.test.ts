/**
 * Confidence-ordered fact search and the bounded active-fact count. Both must
 * stay index-ordered walks that stop at their LIMIT: a temp B-tree here means
 * reading and sorting an organization's whole fact set on every Home turn.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { memoryDomains, memoryFacts } from "../schema/memory-graph";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	countActiveFactsUpTo,
	searchFacts,
	searchFactsWithVisibility,
} from "./memory-graph/fact-search";

type FactSeed = {
	id: string;
	org?: string;
	factType?: string;
	confidence?: number;
	lastAccessedAt?: string | null;
	createdAt?: string;
	visibility?: "private" | "shared" | "org";
	tediId?: string | null;
	archivedAt?: string | null;
	validTo?: string | null;
	memoryScope?: string;
	usePolicy?: string;
};

function seed(seeds: FactSeed[]) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(memoryDomains, memoryFacts));
	const insert = sqlite.prepare(`
		INSERT INTO memory_facts
			(id, organization_id, tedi_id, content, fact_type, confidence,
			 visibility, archived_at, valid_to, last_accessed_at, created_at,
			 memory_scope, use_policy)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	for (const fact of seeds)
		insert.run(
			fact.id,
			fact.org ?? "org-1",
			fact.tediId ?? null,
			`content ${fact.id}`,
			fact.factType ?? "preference",
			fact.confidence ?? 0.8,
			fact.visibility ?? "org",
			fact.archivedAt ?? null,
			fact.validTo ?? null,
			fact.lastAccessedAt ?? null,
			fact.createdAt ?? "2026-10-01T00:00:00.000Z",
			fact.memoryScope ?? "tedi",
			fact.usePolicy ?? "can_use_as_evidence",
		);
	const prepared: string[] = [];
	const db = createDbClient(
		createD1Facade(sqlite, { onPrepare: (query) => prepared.push(query) }),
	);
	const plan = (match: (query: string) => boolean) => {
		const query = prepared.findLast(match)!;
		return sqlite
			.prepare(`EXPLAIN QUERY PLAN ${query}`)
			.all(...Array(query.match(/\?/g)?.length ?? 0).fill(null))
			.map((row) => String(row.detail));
	};
	return { db, plan };
}

const FIXTURE: FactSeed[] = [
	{ id: "top", confidence: 0.95 },
	{
		id: "tie-recent",
		confidence: 0.9,
		lastAccessedAt: "2026-10-20T00:00:00.000Z",
	},
	{
		id: "tie-older",
		confidence: 0.9,
		lastAccessedAt: "2026-10-10T00:00:00.000Z",
	},
	{ id: "tie-never-new", confidence: 0.9, createdAt: "2026-10-05T00:00:00Z" },
	{ id: "tie-never-old", confidence: 0.9, createdAt: "2026-10-02T00:00:00Z" },
	{ id: "low", confidence: 0.2 },
	{ id: "own-private", confidence: 0.85, visibility: "private", tediId: "t1" },
	{
		id: "other-private",
		confidence: 0.99,
		visibility: "private",
		tediId: "t2",
	},
	{ id: "archived", confidence: 0.99, archivedAt: "2026-10-03T00:00:00Z" },
	{ id: "invalidated", confidence: 0.99, validTo: "2026-10-03T00:00:00Z" },
	{ id: "graph-anchor", confidence: 0.99, memoryScope: "graph" },
	{
		id: "not-injected",
		confidence: 0.99,
		usePolicy: "do_not_inject_automatically",
	},
	{
		id: "technical",
		confidence: 0.99,
		factType: "technical",
		createdAt: "2026-10-04T00:00:00Z",
	},
	{ id: "other-org", confidence: 0.99, org: "org-2" },
];

const isRankSearch = (query: string) =>
	query.includes('order by "memory_facts"."confidence" desc');

describe("confidence-ordered fact search", () => {
	it("returns the same eligible facts in confidence, access, then creation order", async () => {
		const { db } = seed(FIXTURE);
		const rows = await searchFactsWithVisibility(db, {
			orgId: "org-1",
			visibilityTediId: "t1",
			factType: "preference",
			limit: 100,
		});
		expect(rows.map((row) => row.id)).toEqual([
			"top",
			"tie-recent",
			"tie-older",
			"tie-never-new",
			"tie-never-old",
			"own-private",
			"low",
		]);
		const limited = await searchFactsWithVisibility(db, {
			orgId: "org-1",
			factType: "preference",
			limit: 2,
		});
		expect(limited.map((row) => row.id)).toEqual(["top", "tie-recent"]);
	});

	it("walks the type rank index in ORDER BY order instead of sorting", async () => {
		const { db, plan } = seed(FIXTURE);
		await searchFactsWithVisibility(db, {
			orgId: "org-1",
			visibilityTediId: "t1",
			factType: "preference",
			limit: 100,
		});
		const steps = plan(isRankSearch);
		expect(steps.join("\n")).toContain("idx_memory_facts_org_type_rank");
		expect(steps.some((step) => step.includes("TEMP B-TREE"))).toBe(false);
	});

	it("walks the live rank index when no fact type is given", async () => {
		const { db, plan } = seed(FIXTURE);
		const rows = await searchFacts(db, { orgId: "org-1", limit: 3 });
		expect(rows.map((row) => row.id)).toEqual([
			"technical",
			"other-private",
			"top",
		]);
		const steps = plan(isRankSearch);
		expect(steps.join("\n")).toContain("idx_memory_facts_org_live_rank");
		expect(steps.some((step) => step.includes("TEMP B-TREE"))).toBe(false);
	});

	it("never reads more than the largest caller page", async () => {
		const { db } = seed(
			Array.from({ length: 510 }, (_, index) => ({ id: `fact-${index}` })),
		);
		expect(
			await searchFacts(db, { orgId: "org-1", limit: 10_000 }),
		).toHaveLength(500);
	});
});

describe("countActiveFactsUpTo", () => {
	it("counts active facts of one organization exactly below the cap", async () => {
		const { db } = seed(FIXTURE);
		// Every org-1 fact except the archived one; invalidated facts still count.
		await expect(countActiveFactsUpTo(db, "org-1", 100)).resolves.toEqual({
			count: 12,
			capped: false,
		});
		await expect(countActiveFactsUpTo(db, "org-1", 12)).resolves.toEqual({
			count: 12,
			capped: false,
		});
	});

	it("stops at the cap and says so", async () => {
		const { db, plan } = seed(FIXTURE);
		await expect(countActiveFactsUpTo(db, "org-1", 5)).resolves.toEqual({
			count: 5,
			capped: true,
		});
		const steps = plan((query) => query.includes("live_facts"));
		expect(steps.join("\n")).toContain(
			"USING COVERING INDEX idx_memory_facts_org_live_rank",
		);
	});
});
