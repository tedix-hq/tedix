import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { memoryFacts, memoryEdges } from "../../schema/memory-graph";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { browseMemory } from "./browse";

async function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	for (const table of [memoryFacts, memoryEdges]) sqlite.exec(schemaDdl(table));
	const db = createDbClient(createD1Facade(sqlite));
	const insert = (
		id: string,
		patch: Partial<typeof memoryFacts.$inferInsert> = {},
	) =>
		db.insert(memoryFacts).values({
			id,
			organizationId: "orchard",
			content: `Full text ${id}`,
			factType: "technical",
			confidence: 0.8,
			visibility: "org",
			createdAt: "2020-01-01T00:00:00.000Z",
			updatedAt: "2026-10-01T00:00:00.000Z",
			...patch,
		});
	const read = (patch: Partial<Parameters<typeof browseMemory>[1]> = {}) =>
		browseMemory(db, {
			orgId: "orchard",
			view: "stale",
			orderBy: "updated",
			limit: 20,
			offset: 0,
			...patch,
		});
	return { db, insert, read };
}

describe("memory browser D1 reads", () => {
	it("paginates deterministically and filters the complete result before pagination", async () => {
		const { insert, read } = await setup();
		for (let i = 0; i < 43; i++)
			await insert(`fact-${String(i).padStart(2, "0")}`, {
				confidence: i % 2 ? 0.9 : 0.4,
			});
		const first = await read();
		const second = await read({ offset: first.nextOffset! });
		const third = await read({ offset: second.nextOffset! });
		expect(first.facts).toHaveLength(20);
		expect(second.facts).toHaveLength(20);
		expect(third.facts).toHaveLength(3);
		expect(third.nextOffset).toBeNull();
		expect(
			new Set(
				[...first.facts, ...second.facts, ...third.facts].map((f) => f.id),
			).size,
		).toBe(43);
		const filtered = await read({
			minConfidence: 0.8,
			search: "Full text fact-4",
			orderBy: "confidence",
		});
		expect(filtered.facts.map((f) => f.id)).toEqual(["fact-41"]);
	});

	it("uses last accessed or creation age, excludes archived and private/foreign facts", async () => {
		const { insert, read } = await setup();
		await insert("old");
		await insert("recently-used", { lastAccessedAt: new Date().toISOString() });
		await insert("recently-created", { createdAt: new Date().toISOString() });
		await insert("archived", { archivedAt: "2026-01-01" });
		await insert("foreign", { organizationId: "other" });
		await insert("private", { tediId: "peer", visibility: "private" });
		await insert("own-private", { tediId: "self", visibility: "private" });
		expect((await read()).facts.map((f) => f.id)).toEqual(["old"]);
		expect((await read({ tediId: "self" })).facts.map((f) => f.id)).toEqual([
			"old",
			"own-private",
		]);
	});

	it("lists each source once for contradiction edges and hides private targets", async () => {
		const { db, insert, read } = await setup();
		for (const id of ["source", "target-a", "target-b", "hidden-source"])
			await insert(id);
		await insert("private-target", { visibility: "private", tediId: "peer" });
		await db.insert(memoryEdges).values([
			{
				id: "edge-a",
				sourceFactId: "source",
				targetFactId: "target-a",
				relationType: "contradicts",
			},
			{
				id: "edge-b",
				sourceFactId: "source",
				targetFactId: "target-b",
				relationType: "contradicts",
			},
			{
				id: "edge-private",
				sourceFactId: "hidden-source",
				targetFactId: "private-target",
				relationType: "contradicts",
			},
		]);
		expect(
			(await read({ view: "contradictions" })).facts.map((f) => f.id),
		).toEqual(["source"]);
	});

	it("keeps observation history out of the current view and returns full text", async () => {
		const { insert, read } = await setup();
		const content = "Long observation evidence ".repeat(150);
		await insert("current", {
			content,
			source: "consolidation://observation",
			metadata: { consolidation: { isHistory: false } },
		});
		await insert("history", {
			source: "consolidation://observation",
			metadata: { consolidation: { isHistory: true } },
		});
		await insert("gap", { factType: "gap" });
		expect(
			(await read({ view: "observations" })).facts.map((f) => f.content),
		).toEqual([content]);
		expect((await read({ view: "gaps" })).facts.map((f) => f.id)).toEqual([
			"gap",
		]);
	});
});
