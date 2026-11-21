import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { describeGovernanceConformance } from "@tedix/agent-governance/conformance";
import {
	createInMemoryAdapters,
	InMemoryMemoryAdapter,
} from "@tedix/agent-governance/in-memory";
import {
	exportMemory,
	importMemory,
} from "@tedix/agent-governance/memory-transfer";
import type { MemoryRevision } from "@tedix/agent-governance/types";
import { hashValue } from "@tedix/agent-governance/hash";
import { createDbClient } from "../../client";
import { memoryFacts, memoryEdges } from "../../schema/memory-graph";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { OrganizationMemoryAdapter, factReviewState } from "./memory-adapter";
import { getFactById } from "./facts";
import { searchFacts } from "./fact-search";
const scope = { organizationId: "org-test" };
const provenance = {
	actor: { id: "agent-1", kind: "agent" },
	source: { surface: "test" },
};
const databases: DatabaseSync[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function fixture(onPrepare?: (query: string, sqlite: DatabaseSync) => void) {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys=OFF");
	sqlite.exec(schemaDdl(memoryFacts, memoryEdges));
	const plans = new Map<string, string[]>();
	const db = createDbClient(
		createD1Facade(sqlite, {
			onPrepare(query) {
				onPrepare?.(query, sqlite);
				if (query.startsWith("select") && query.includes("INDEXED BY")) {
					const params = Array.from(query.matchAll(/\?/g), () => "");
					plans.set(
						query,
						(
							sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all(...params) as {
								detail: string;
							}[]
						).map((row) => row.detail),
					);
				}
			},
		}),
	);
	const memory = new OrganizationMemoryAdapter(db, scope);
	return { sqlite, db, memory, plans };
}
describeGovernanceConformance("Organization fact memory conformance", () => ({
	...createInMemoryAdapters(),
	memory: fixture().memory,
}));
describe("organization fact memory", () => {
	it("round-trips imported history with timestamps, reviews and rollback links", async () => {
		const source = new InMemoryMemoryAdapter(
			() => new Date("2024-03-01T00:00:00.000Z"),
		);
		const first = await source.write({
			key: "history",
			value: { fact: "original" },
			provenance,
			writtenAt: "2024-01-01T00:00:00.000Z",
			review: "approved",
			reviewedBy: "reviewer-1",
			reviewedAt: "2024-01-02T00:00:00.000Z",
			reviewNote: "Verified against source",
		});
		await source.write({
			key: "history",
			value: { fact: "rejected change" },
			provenance,
			writtenAt: "2024-02-01T00:00:00.000Z",
			review: "rejected",
			reviewedBy: "reviewer-2",
			reviewedAt: "2024-02-02T00:00:00.000Z",
			reviewNote: "",
		});
		await source.rollback("history", first.revisionId, provenance);
		const original = await exportMemory(source);
		const { memory } = fixture();
		expect(await importMemory(memory, original, "source-store")).toBe(3);
		const parse = (bundle: string): MemoryRevision[] =>
			bundle
				.trim()
				.split("\n")
				.map((line) => JSON.parse(line));
		const originals = parse(original);
		const imported = parse(await exportMemory(memory));
		const localIds = new Map(
			originals.map((row, i) => [row.revisionId, imported[i]!.revisionId]),
		);
		// Import allocates local IDs and records the source of each revision.
		expect(imported).toEqual(
			originals.map((row) => ({
				...row,
				revisionId: localIds.get(row.revisionId),
				provenance: {
					...row.provenance,
					importedFrom: [{ store: "source-store", revisionId: row.revisionId }],
				},
				...(row.rolledBackFrom !== undefined
					? { rolledBackFrom: localIds.get(row.rolledBackFrom) }
					: {}),
			})),
		);
	});
	it("maps legacy review statuses without changing reader, search or edge results", async () => {
		const { db, memory } = fixture();
		const statuses = [
			"pending",
			"confirmed",
			"evidence_only",
			"restricted",
			"stale",
			"disputed",
			"rejected",
			"superseded",
			null,
		] as const;
		for (const [index, reviewStatus] of statuses.entries())
			await db.insert(memoryFacts).values({
				id: `fact-${index}`,
				...scope,
				tediId: "owner",
				content: `Fact ${index}`,
				factType: "technical",
				reviewStatus,
				source: "doc://guide",
				sourceSessionId: "session-1",
				metadata: { retained: true },
			});
		await db.insert(memoryEdges).values({
			id: "edge",
			sourceFactId: "fact-0",
			targetFactId: "fact-1",
			relationType: "related_to",
		});
		const edgesBefore = await db.select().from(memoryEdges);
		const before = await searchFacts(db, scope);
		const factBefore = await getFactById(db, scope, "fact-1");
		for (const [index, status] of statuses.entries()) {
			const entry = await memory.read(`fact-${index}`);
			expect(entry?.current).toMatchObject({
				key: `fact-${index}`,
				value: `Fact ${index}`,
				hash: await hashValue(`Fact ${index}`),
				review: factReviewState(status),
				provenance: {
					actor: { id: "memory-graph", kind: "system" },
					source: { surface: "doc://guide", traceId: "session-1" },
				},
			});
		}
		expect(statuses.map(factReviewState)).toEqual([
			"pending",
			"approved",
			"approved",
			"rejected",
			"rejected",
			"rejected",
			"rejected",
			"rejected",
			"pending",
		]);
		await memory.list();
		expect(await searchFacts(db, scope)).toEqual(before);
		expect(await getFactById(db, scope, "fact-1")).toEqual(factBefore);
		await memory.write({ key: "fact-1", value: "Changed fact", provenance });
		await memory.rollback(
			"fact-1",
			(await memory.history("fact-1"))[0]!.revisionId,
			provenance,
		);
		expect(
			(await searchFacts(db, scope)).map(
				({ metadata, updatedAt, ...row }) => row,
			),
		).toEqual(before.map(({ metadata, updatedAt, ...row }) => row));
		expect((await getFactById(db, scope, "fact-1"))?.metadata?.retained).toBe(
			true,
		);
		expect(await db.select().from(memoryEdges)).toEqual(edgesBefore);
	});
	it("fences tenants and competing writes while preserving external fact edits", async () => {
		let compete = false;
		const { db, memory } = fixture((query, sqlite) => {
			if (compete && query.startsWith("update")) {
				compete = false;
				sqlite
					.prepare("UPDATE memory_facts SET content = ? WHERE id = ?")
					.run("competing", "key");
			}
		});
		await memory.write({ key: "key", value: "first", provenance });
		const other = new OrganizationMemoryAdapter(db, {
			organizationId: "org-other",
		});
		expect(await other.read("key")).toBeNull();
		expect(await other.list()).toEqual([]);
		const revision = (await memory.history("key"))[0]!;
		await expect(
			other.review(revision.revisionId, "approve", provenance.actor),
		).rejects.toThrow("Unknown memory revision");
		await expect(
			other.write({ key: "key", value: "foreign", provenance }),
		).rejects.toThrow();
		expect(
			() =>
				new OrganizationMemoryAdapter(db, {
					...scope,
					workspaceId: "workspace",
				}),
		).toThrow("workspace store");
		// An existing writer's content edit is captured before the next adapter write.
		await db.update(memoryFacts).set({ content: "external" });
		await memory.write({ key: "key", value: "third", provenance });
		expect((await memory.history("key")).map((r) => r.value)).toEqual([
			"first",
			"external",
			"third",
		]);
		compete = true;
		await expect(
			memory.write({ key: "key", value: "lost", provenance }),
		).rejects.toThrow("Memory fact changed concurrently");
		expect((await memory.read("key"))?.current.value).toBe("competing");
		expect(await memory.history("key")).toHaveLength(4);
	});
	it("uses existing index seeks for exact reads and bounded list pages", async () => {
		const { db, memory, plans } = fixture();
		for (const source of [null, "doc://guide"])
			for (let i = 0; i < 101; i++)
				await db.insert(memoryFacts).values({
					id: `${source ?? "null"}:${i}`,
					...scope,
					source,
					content: "text",
					factType: "technical",
				});
		expect(await memory.list()).toHaveLength(202);
		await memory.read("null:0");
		for (const [query, plan] of plans) {
			expect(plan.join(" ")).toContain(
				query.includes("sqlite_autoindex_memory_facts_1")
					? "SEARCH memory_facts USING INDEX sqlite_autoindex_memory_facts_1 (id=?)"
					: "SEARCH memory_facts USING INDEX idx_memory_facts_org_source_id",
			);
			expect(plan.join(" ")).not.toMatch(/SCAN|TEMP B-TREE/);
		}
		expect(plans.size).toBe(5);
	});
});
