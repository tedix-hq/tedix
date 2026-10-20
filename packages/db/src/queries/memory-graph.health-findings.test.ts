/**
 * Memory health findings against a real SQLite backing: each finding names the
 * right records, counts are capped, other organizations never leak in, and the
 * planner reaches `memory_facts`/`memory_edges` through an index (never a full
 * table scan), which is what keeps this read safe on a large organization.
 */

import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import {
	memoryDomains,
	memoryEdges,
	memoryFacts,
} from "../schema/memory-graph";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { getMemoryHealthFindings } from "./memory-graph/health-findings";

const NOW = new Date("2026-10-20T12:00:00.000Z");
const daysAgo = (days: number) =>
	new Date(NOW.getTime() - days * 86_400_000).toISOString();

type Seed = {
	id: string;
	org?: string;
	created?: string;
	accessed?: string | null;
	verified?: string | null;
	topicKey?: string | null;
	archived?: string | null;
	source?: string | null;
};

function setup(seeds: Seed[], edges: [string, string, string, string][] = []) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(memoryDomains, memoryFacts, memoryEdges));
	const insert = sqlite.prepare(`
		INSERT INTO memory_facts
			(id, organization_id, content, fact_type, confidence, created_at,
			 updated_at, last_accessed_at, last_verified_at, topic_key, archived_at, source)
		VALUES (?, ?, ?, 'technical', 0.8, ?, ?, ?, ?, ?, ?, ?)
	`);
	for (const s of seeds) {
		const created = s.created ?? daysAgo(1);
		insert.run(
			s.id,
			s.org ?? "org-1",
			`content ${s.id}`,
			created,
			created,
			s.accessed ?? null,
			s.verified ?? null,
			s.topicKey ?? null,
			s.archived ?? null,
			s.source ?? null,
		);
	}
	for (const [id, from, to, type] of edges) {
		sqlite
			.prepare(
				"INSERT INTO memory_edges (id, source_fact_id, target_fact_id, relation_type, created_at) VALUES (?, ?, ?, ?, ?)",
			)
			.run(id, from, to, type, daysAgo(1));
	}
	const seen: string[] = [];
	const prepare = sqlite.prepare.bind(sqlite);
	sqlite.prepare = ((sql: string) => {
		seen.push(sql);
		return prepare(sql);
	}) as typeof sqlite.prepare;
	return { db: createDbClient(createD1Facade(sqlite)), seen, prepare };
}

const kind = (
	result: Awaited<ReturnType<typeof getMemoryHealthFindings>>,
	name: string,
) => {
	const finding = result.findings.find((f) => f.kind === name);
	if (!finding) throw new Error(`missing ${name}`);
	return finding;
};

describe("getMemoryHealthFindings", () => {
	it("names unused, stale-but-used, duplicate, contradicting and orphan facts", async () => {
		const { db } = setup(
			[
				{ id: "never", created: daysAgo(100) },
				{ id: "old-read", created: daysAgo(200), accessed: daysAgo(90) },
				{
					id: "stale-used",
					created: daysAgo(200),
					accessed: daysAgo(2),
					source: "doc://runbook.md",
				},
				{
					id: "fresh",
					created: daysAgo(1),
					accessed: daysAgo(1),
					verified: daysAgo(1),
				},
				{
					id: "dup-a",
					created: daysAgo(5),
					accessed: daysAgo(1),
					topicKey: "k.one",
				},
				{
					id: "dup-b",
					created: daysAgo(4),
					accessed: daysAgo(1),
					topicKey: "k.one",
				},
				{ id: "other-org", org: "org-2", created: daysAgo(100) },
				{ id: "archived", created: daysAgo(100), archived: daysAgo(1) },
			],
			[["e1", "fresh", "dup-a", "contradicts"]],
		);
		const result = await getMemoryHealthFindings(db, "org-1", { now: NOW });

		const unused = kind(result, "unused");
		expect(unused.samples.map((s) => s.factId).sort()).toEqual([
			"never",
			"old-read",
		]);
		expect(unused.count).toBe(2);

		const stale = kind(result, "stale_in_use");
		expect(stale.samples.map((s) => s.factId)).toEqual(["stale-used"]);
		expect(stale.samples[0]?.source).toBe("doc://runbook.md");

		const dup = kind(result, "duplicate");
		expect(dup.count).toBe(1);
		expect(dup.samples[0]?.detail).toContain("2 current facts");

		const contradiction = kind(result, "contradiction");
		expect(contradiction.count).toBe(1);
		expect(contradiction.samples[0]?.factId).toBe("fresh");

		const orphanIds = kind(result, "orphan").samples.map((s) => s.factId);
		expect(orphanIds).not.toContain("fresh");
		expect(orphanIds).not.toContain("dup-a");
		expect(orphanIds).not.toContain("other-org");
		expect(orphanIds).not.toContain("archived");
		expect(kind(result, "orphan").count).toBe(4);
	});

	it("caps counts instead of counting an unbounded set", async () => {
		const seeds = Array.from({ length: 520 }, (_, i) => ({
			id: `f${i}`,
			created: daysAgo(100),
		}));
		const { db } = setup(seeds);
		const unused = kind(
			await getMemoryHealthFindings(db, "org-1", { now: NOW }),
			"unused",
		);
		expect(unused.count).toBe(500);
		expect(unused.capped).toBe(true);
		expect(unused.samples).toHaveLength(5);
	});

	it("bounds every statement and reaches memory tables through an index", async () => {
		const { db, seen, prepare } = setup([{ id: "a", created: daysAgo(100) }]);
		await getMemoryHealthFindings(db, "org-1", { now: NOW });
		expect(seen.length).toBeGreaterThanOrEqual(12);
		const plans: string[] = [];
		for (const statement of seen) {
			expect(statement.toLowerCase()).toContain("limit");
			const placeholders = statement.split("?").length - 1;
			expect(placeholders).toBeLessThanOrEqual(100);
			const plan = prepare(`EXPLAIN QUERY PLAN ${statement}`)
				.all(...Array<null>(placeholders).fill(null))
				.map((row) => String((row as { detail: string }).detail));
			for (const line of plan) {
				plans.push(line);
				expect(line, statement).not.toMatch(
					/^SCAN (memory_facts|memory_edges|contradicted)\b/,
				);
			}
		}
		expect(plans.some((line) => line.includes("SEARCH memory_facts"))).toBe(
			true,
		);
		// No statement may sort or aggregate an unbounded set in a temp tree.
		expect(plans.filter((line) => line.includes("TEMP B-TREE"))).toEqual([]);
	});
});
