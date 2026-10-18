import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { memoryFacts, memoryEdges } from "../schema/memory-graph";
import {
	memoryEntities,
	memoryEntityMentions,
	memoryEntityResolutions,
} from "../schema/memory-entities";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import {
	consolidateMemory,
	filterConsolidatedEvidence,
	listMemoryObservations,
	readConsolidation,
	preferConsolidatedFacts,
} from "./memory-graph/observations";
import { invalidateFact } from "./memory-graph/fact-lifecycle";
import { createEdge } from "./memory-graph/edges";
import { updateFact } from "./memory-graph/facts";
import { filterEvidenceBackedLessons } from "./memory-graph/agent-lessons";

const ORG = "fictional-orchard";
const TOPIC = "orchard:repository";
function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	for (const table of [
		memoryFacts,
		memoryEdges,
		memoryEntities,
		memoryEntityMentions,
		memoryEntityResolutions,
	])
		sqlite.exec(schemaDdl(table));
	const db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
	const fact = async (
		id: string,
		content: string,
		orgId = ORG,
		options: {
			tediId?: string;
			visibility?: "org" | "private";
			topic?: string;
			confidence?: number;
			observationTopic?: string;
		} = {},
	) => {
		await db.insert(memoryFacts).values({
			id,
			organizationId: orgId,
			content,
			topicKey: options.topic ?? TOPIC,
			metadata: options.observationTopic
				? { observationTopic: options.observationTopic }
				: undefined,
			factType: "technical",
			status: "active",
			reviewStatus: "confirmed",
			visibility: options.visibility ?? "org",
			memoryScope: options.tediId ? "tedi" : "org",
			tediId: options.tediId,
			confidence: options.confidence ?? 0.8,
			validFrom: id === "a" ? "2026-09-01T00:00:00Z" : "2026-09-02T00:00:00Z",
		});
	};
	const heads = () => listMemoryObservations(db, ORG);
	const observation = async () =>
		(await heads()).find(
			(row) => readConsolidation(row)?.kind === "observation",
		)!;
	const summary = async () =>
		(await heads()).find(
			(row) => readConsolidation(row)?.kind === "standing_summary",
		)!;
	return { sqlite, db, fact, heads, observation, summary };
}

describe("evidence-backed observations and standing summaries", () => {
	it("consolidates one scoped topic, keeps canonical quotes, and reruns without new versions", async () => {
		const { db, fact, heads, observation, summary } = setup();
		await fact("a", "The Orchard repo uses batch writes.", ORG, {
			confidence: 0.9,
		});
		await fact("b", "The Orchard repo tests writes with a D1 facade.", ORG, {
			confidence: 0.7,
		});
		await consolidateMemory(db, ORG);
		expect(await heads()).toHaveLength(2);
		const row = await observation();
		expect(row.content).toBe(
			"The Orchard repo uses batch writes. The Orchard repo tests writes with a D1 facade.",
		);
		expect(row.confidence).toBeCloseTo(0.8);
		expect(readConsolidation(row)).toMatchObject({
			revision: 1,
			state: "live",
			firstSeen: "2026-09-01T00:00:00Z",
			lastSeen: "2026-09-02T00:00:00Z",
			evidence: {
				version: 1,
				supportCount: 2,
				sources: [
					{
						kind: "fact",
						id: "a",
						quote: "The Orchard repo uses batch writes.",
					},
					{
						kind: "fact",
						id: "b",
						quote: "The Orchard repo tests writes with a D1 facade.",
					},
				],
			},
		});
		expect(readConsolidation(await summary())?.observationIds).toEqual([
			row.id,
		]);
		await consolidateMemory(db, ORG);
		expect(readConsolidation(await observation())?.revision).toBe(1);
		expect(
			await listMemoryObservations(db, ORG, { includeHistory: true }),
		).toHaveLength(2);
	});
	it("refines new evidence and retains prior text and a trace", async () => {
		const { db, fact, observation } = setup();
		await fact("a", "Orchard uses batch writes.");
		await fact("b", "Orchard tests batch writes.");
		await consolidateMemory(db, ORG);
		const before = await observation();
		await fact("c", "Orchard chunks writes below 100 parameters.");
		await consolidateMemory(db, ORG);
		const after = await observation();
		expect(after.id).toBe(before.id);
		expect(readConsolidation(after)).toMatchObject({
			revision: 2,
			evidence: { supportCount: 3 },
			refresh: { reason: "source_changed", previousText: before.content },
		});
		const history = await listMemoryObservations(db, ORG, {
			includeHistory: true,
		});
		expect(
			history.find(
				(row) => row.id === readConsolidation(after)?.previousVersionId,
			)?.content,
		).toBe(before.content);
	});
	it("retracts the exact lost claim from both levels immediately, then drops all claims", async () => {
		const { db, fact, observation, summary } = setup();
		await fact("a", "Orchard uses batches.");
		await fact("b", "Orchard runs D1 tests.");
		await consolidateMemory(db, ORG);
		await invalidateFact(db, "a", "Fictional fixture correction");
		expect((await observation()).content).toBe("Orchard runs D1 tests.");
		expect((await summary()).content).toBe("Orchard runs D1 tests.");
		expect(readConsolidation(await observation())).toMatchObject({
			revision: 2,
			evidence: { supportCount: 1 },
			refresh: {
				reason: "source_invalidated",
				removedSourceFactIds: ["a"],
				sourceFactIds: expect.arrayContaining(["a"]),
			},
		});
		await invalidateFact(db, "b");
		for (const row of [await observation(), await summary()])
			expect(readConsolidation(row)).toMatchObject({
				state: "retracted",
				evidence: { supportCount: 0, state: "held" },
			});
		expect(
			await filterConsolidatedEvidence(db, ORG, [
				await observation(),
				await summary(),
			]),
		).toEqual([]);
	});
	it("marks contradictions disputed with both sides, excludes them from summaries, and recovers after retraction", async () => {
		const { db, fact, observation, summary } = setup();
		await fact("a", "Orchard builds on Mondays.");
		await fact("b", "Orchard never builds on Mondays.");
		await consolidateMemory(db, ORG);
		await createEdge(db, {
			id: "conflict",
			sourceFactId: "b",
			targetFactId: "a",
			relationType: "contradicts",
		});
		const disputed = await observation();
		expect(readConsolidation(disputed)).toMatchObject({
			state: "disputed",
			evidence: { state: "held", supportCount: 2 },
		});
		expect(disputed.content).toContain("Conflicting evidence:");
		expect(readConsolidation(await summary())?.state).toBe("retracted");
		await invalidateFact(db, "b");
		expect(readConsolidation(await observation())?.state).toBe("live");
		expect((await summary()).content).toBe("Orchard builds on Mondays.");
	});
	it("re-evaluates a supersede edge even if validTo was not set", async () => {
		const { db, fact, observation, summary } = setup();
		await fact("a", "Orchard uses old storage.");
		await fact("b", "Orchard has nightly checks.");
		await consolidateMemory(db, ORG);
		await fact("c", "Orchard uses new storage.");
		await createEdge(db, {
			id: "replace",
			sourceFactId: "c",
			targetFactId: "a",
			relationType: "supersedes",
		});
		expect((await observation()).content).not.toContain("old storage");
		expect((await summary()).content).toContain("new storage");
		expect(
			readConsolidation(await observation())?.refresh.removedSourceFactIds,
		).toEqual(["a"]);
	});
	it("fails closed between a direct source change and background refresh, preserving raw-fact fallback", async () => {
		const { sqlite, db, fact, observation, summary } = setup();
		await fact("a", "Orchard uses batches.");
		await fact("b", "Orchard runs D1 tests.");
		await consolidateMemory(db, ORG);
		sqlite.exec(
			"UPDATE memory_facts SET valid_to = CURRENT_TIMESTAMP WHERE id = 'a'",
		);
		const source = await db.select().from(memoryFacts);
		const raw = source.find((row) => row.id === "b")!;
		expect(
			await filterEvidenceBackedLessons(db, ORG, [
				raw,
				await observation(),
				await summary(),
			]),
		).toEqual([raw]);
		await consolidateMemory(db, ORG);
		expect(readConsolidation(await summary())?.evidence.supportCount).toBe(1);
	});
	it("prefers a live summary over its observations and raw facts at the shared recall boundary", async () => {
		const { db, fact, observation, summary } = setup();
		await fact("a", "Orchard uses batches.");
		await fact("b", "Orchard runs D1 tests.");
		await consolidateMemory(db, ORG);
		const all = await db.select().from(memoryFacts);
		expect(
			(await filterEvidenceBackedLessons(db, ORG, all)).map((row) => row.id),
		).toEqual([(await summary()).id]);
		expect(
			(
				await filterEvidenceBackedLessons(
					db,
					ORG,
					all.filter(
						(row) =>
							row.id !==
							(readConsolidation(row)?.kind === "standing_summary"
								? row.id
								: ""),
					),
				)
			).map((row) => row.id),
		).toEqual([(await observation()).id]);
	});
	it("keeps organizations and private tedi scopes separate", async () => {
		const { db, fact, heads } = setup();
		await fact("a", "Orchard uses batches.");
		await fact("other", "Other tenant secret.", "fictional-pine");
		await fact("private", "A private worker secret.", ORG, {
			tediId: "worker-orchard",
			visibility: "private",
		});
		await consolidateMemory(db, ORG);
		expect(await heads()).toEqual([]);
		await fact("b", "Orchard tests batches.");
		await consolidateMemory(db, ORG);
		for (const row of await heads()) {
			expect(row.content).not.toContain("secret");
			expect(readConsolidation(row)?.evidence.supportCount).toBe(2);
		}
		expect(await listMemoryObservations(db, "fictional-pine")).toEqual([]);
	});
	it("refreshes edited source text without retaining its previous unsupported claim", async () => {
		const { db, fact, observation, summary } = setup();
		await fact("a", "Orchard uses old batches.");
		await fact("b", "Orchard runs tests.");
		await consolidateMemory(db, ORG);
		await updateFact(db, "a", { content: "Orchard uses revised batches." });
		expect((await observation()).content).toContain("revised batches");
		expect((await summary()).content).not.toContain("old batches");
	});
	it("does not claim completeness for oversized clusters and stays under D1 parameter limits", async () => {
		const { db, fact, heads } = setup();
		for (let i = 0; i < 51; i++)
			await fact(`fact-${i}`, `Orchard evidence ${i}.`);
		expect((await consolidateMemory(db, ORG)).overflow).toBe(1);
		expect(await heads()).toEqual([]);
	});
	it("holds cached claims after an edit beyond the quote or a privacy change", async () => {
		const { sqlite, db, fact, observation, summary } = setup();
		await fact("a", "Orchard " + "evidence ".repeat(45) + "old ending.");
		await fact("b", "Orchard runs tests.");
		await consolidateMemory(db, ORG);
		sqlite.exec(
			"UPDATE memory_facts SET content = replace(content, 'old ending.', 'new ending.') WHERE id = 'a'",
		);
		expect(
			await filterConsolidatedEvidence(db, ORG, [
				await observation(),
				await summary(),
			]),
		).toEqual([]);
		await consolidateMemory(db, ORG);
		sqlite.exec(
			"UPDATE memory_facts SET visibility = 'private' WHERE id = 'a'",
		);
		expect(
			await filterConsolidatedEvidence(db, ORG, [
				await observation(),
				await summary(),
			]),
		).toEqual([]);
	});
	it("holds cached claims on a directly written contradiction before reflection", async () => {
		const { sqlite, db, fact, observation, summary } = setup();
		await fact("a", "Orchard uses Mondays.");
		await fact("b", "Orchard uses Tuesdays.");
		await consolidateMemory(db, ORG);
		sqlite.exec(
			"INSERT INTO memory_edges (id, source_fact_id, target_fact_id, relation_type) VALUES ('direct-conflict', 'a', 'b', 'contradicts')",
		);
		expect(
			await filterConsolidatedEvidence(db, ORG, [
				await observation(),
				await summary(),
			]),
		).toEqual([]);
	});
	it("finds a standing summary for Home when initial candidates are only raw facts", async () => {
		const { db, fact, summary } = setup();
		await fact("a", "Orchard uses batches.");
		await fact("b", "Orchard runs tests.");
		await consolidateMemory(db, ORG);
		const raw = (await db.select().from(memoryFacts)).filter(
			(row) => row.id === "a",
		);
		expect(
			(await preferConsolidatedFacts(db, ORG, raw)).map((row) => row.id),
		).toEqual([(await summary()).id]);
	});
	it("summarizes separate topics for one accepted entity", async () => {
		const { db, fact, heads } = setup();
		await db.insert(memoryEntities).values({
			id: "orchard-repo",
			organizationId: ORG,
			entityType: "repository",
			displayName: "Orchard",
			normalizedName: "orchard",
		});
		for (const [id, topic] of [
			["a", "orchard:build"],
			["b", "orchard:build"],
			["c", "orchard:test"],
			["d", "orchard:test"],
		] as const) {
			await fact(id, `Orchard ${id} evidence.`, ORG, { topic });
			await db.insert(memoryEntityMentions).values({
				id: `mention-${id}`,
				organizationId: ORG,
				occurrenceKey: id,
				sourceFactId: id,
				surfaceForm: "Orchard",
				normalizedForm: "orchard",
				proposedType: "repository",
				extractor: "fictional-fixture",
				extractorVersion: "1",
				confidence: 1,
			});
			await db.insert(memoryEntityResolutions).values({
				id: `resolution-${id}`,
				organizationId: ORG,
				mentionId: `mention-${id}`,
				entityId: "orchard-repo",
				decisionId: `decision-${id}`,
				resolutionKind: "linked",
				confidence: 1,
				validFrom: "2026-09-01T00:00:00Z",
			});
		}
		await consolidateMemory(db, ORG);
		const rows = await heads();
		expect(rows).toHaveLength(2);
		const summary = rows.find(
			(row) => readConsolidation(row)?.kind === "standing_summary",
		)!;
		expect(readConsolidation(summary)).toMatchObject({
			entityKey: "entity:orchard-repo",
			evidence: { supportCount: 4 },
		});
		expect(readConsolidation(summary)?.observationIds).toHaveLength(1);
		await invalidateFact(db, "a");
		expect(
			(await heads()).find((row) => row.id === summary.id)?.content,
		).not.toContain("Orchard a evidence.");
	});
	it("makes progress beyond the newest ten topics on repeated bounded runs", async () => {
		const { db, fact, heads } = setup();
		for (let i = 0; i < 12; i++) {
			await fact(`topic-${i}-a`, `Orchard ${i} evidence A.`, ORG, {
				topic: `orchard:${i}`,
			});
			await fact(`topic-${i}-b`, `Orchard ${i} evidence B.`, ORG, {
				topic: `orchard:${i}`,
			});
		}
		await consolidateMemory(db, ORG);
		await consolidateMemory(db, ORG);
		expect(
			(await heads()).filter(
				(row) => readConsolidation(row)?.kind === "observation",
			),
		).toHaveLength(12);
	});
	it("consolidates independent source identities sharing an observation topic and deduplicates repeated statements", async () => {
		const { db, fact, observation } = setup();
		await fact("a", "Orchard uses batches.", ORG, {
			topic: "source:one",
			observationTopic: TOPIC,
		});
		await fact("b", "Orchard uses batches.", ORG, {
			topic: "source:two",
			observationTopic: TOPIC,
		});
		await Promise.all([
			consolidateMemory(db, ORG, { topicKey: TOPIC }),
			consolidateMemory(db, ORG, { topicKey: TOPIC }),
		]);
		expect((await observation()).content).toBe("Orchard uses batches.");
		expect(readConsolidation(await observation())).toMatchObject({
			revision: 1,
			evidence: { supportCount: 2 },
		});
		expect(
			await listMemoryObservations(db, ORG, { includeHistory: true }),
		).toHaveLength(2);
	});
	it("never resurrects an archived observation or uses it in a standing summary", async () => {
		const { db, fact, heads, observation, summary } = setup();
		await fact("a", "Orchard uses batches.");
		await fact("b", "Orchard runs tests.");
		await consolidateMemory(db, ORG);
		const old = await observation();
		await updateFact(db, old.id, { archivedAt: "2026-10-01T00:00:00Z" });
		await fact("c", "Orchard uses checks.");
		await consolidateMemory(db, ORG);
		expect((await heads()).some((row) => row.id === old.id)).toBe(false);
		expect(readConsolidation(await summary())?.state).toBe("retracted");
		const retained = (
			await listMemoryObservations(db, ORG, { includeHistory: true })
		).find((row) => row.id === old.id)!;
		expect(retained.archivedAt).toBe("2026-10-01T00:00:00Z");
	});
	it("lists org and own observations while excluding another worker's private sources", async () => {
		const { db, fact } = setup();
		await fact("a", "Orchard org source A.");
		await fact("b", "Orchard org source B.");
		for (const worker of ["own-worker", "other-worker"])
			for (const suffix of ["a", "b"])
				await fact(
					`${worker}-${suffix}`,
					`${worker} private source ${suffix}.`,
					ORG,
					{ tediId: worker, visibility: "private" },
				);
		await consolidateMemory(db, ORG);
		const rows = await listMemoryObservations(db, ORG, {
			tediId: "own-worker",
		});
		expect(rows).toHaveLength(4);
		expect(rows.every((row) => !row.content.includes("other-worker"))).toBe(
			true,
		);
	});
	it("cites a contradictory source with a different topic key and refreshes when that source is retracted", async () => {
		const { db, fact, observation, summary } = setup();
		await fact("a", "Orchard builds on Mondays.");
		await fact("b", "Orchard runs tests.");
		await consolidateMemory(db, ORG);
		await fact("c", "Orchard never builds on Mondays.", ORG, {
			topic: "orchard:new-report",
		});
		await createEdge(db, {
			id: "cross-topic-conflict",
			sourceFactId: "c",
			targetFactId: "a",
			relationType: "contradicts",
		});
		expect(readConsolidation(await observation())).toMatchObject({
			state: "disputed",
			evidence: {
				supportCount: 3,
				sources: expect.arrayContaining([
					expect.objectContaining({ id: "a" }),
					expect.objectContaining({ id: "c" }),
				]),
			},
		});
		expect(readConsolidation(await summary())?.state).toBe("retracted");
		await invalidateFact(db, "c");
		expect(readConsolidation(await observation())?.state).toBe("live");
		expect((await summary()).content).not.toContain("never builds");
	});
});
