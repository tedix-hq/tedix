import type { SQLInputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { eq, sql } from "drizzle-orm";
import { SearchResultSchema } from "@tedix/api-contract/schemas/memory-graph";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { memoryFacts } from "../../schema/memory-graph";
import { auditMemoryGraph } from "../memory-audit";
import {
	createMemoryEntity,
	getMemoryEntity,
	recordMemoryEntityMention,
	proposeMemoryEntityResolution,
	reviewMemoryEntityResolutionProposal,
} from "../memory-entities";
import { listAutoLinkFacts, createAutoLinkEdge } from "./auto-linking";
import { findCitationDependents } from "./fact-citations";
import {
	createFact,
	findCurrentFactsByTopicKey,
	findFactBySourceHash,
} from "./facts";
import {
	lexicalRecall,
	graphRecall,
	temporalRecall,
	hydrateRecall,
	recordRecallAccess,
} from "./hybrid-recall";
import { selectMemoryStore, type TenantMemoryStorage } from "./tenant-store";

const scope = {
	organizationId: "fictional-grove",
	tediId: "tedi-a",
	now: "2026-11-05T12:00:00.000Z",
};
const orgScope = { organizationId: scope.organizationId };
const databases: ReturnType<typeof createMigratedSqlite>[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});

function fixture(plane: "platform-d1" | "do-local-sqlite") {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	databases.push(sqlite);
	const storage: TenantMemoryStorage = {
		sql: {
			exec(query, ...bindings) {
				const statement = sqlite.prepare(query);
				const columnNames = statement.columns().map((column) => column.name);
				statement.setReturnArrays(true);
				// setReturnArrays(true) makes rows arrays; node:sqlite's types still say objects.
				const rows = statement.all(
					...(bindings as SQLInputValue[]),
				) as unknown as (string | number | null | ArrayBuffer)[][];
				return {
					columnNames,
					raw: () => rows.values(),
					rowsRead: rows.length,
					rowsWritten: 0,
				};
			},
		},
		transactionSync(callback) {
			sqlite.exec("BEGIN");
			try {
				const result = callback();
				sqlite.exec("COMMIT");
				return result;
			} catch (error) {
				sqlite.exec("ROLLBACK");
				throw error;
			}
		},
	};
	const selected = selectMemoryStore(
		plane === "do-local-sqlite"
			? { plane, storage }
			: { plane, db: createDbClient(createD1Facade(sqlite)) },
	);
	const add = (
		id: string,
		more: Partial<typeof memoryFacts.$inferInsert> = {},
	) =>
		createFact(selected.db, {
			id,
			organizationId: scope.organizationId,
			tediId: scope.tediId,
			domainId: "fictional-domain",
			content: "Cobalt migration uses workspace stores",
			factType: "technical",
			visibility: "org",
			confidence: 0.8,
			reviewStatus: "confirmed",
			memoryScope: "org",
			usePolicy: "can_use_as_evidence",
			validFrom: "2026-11-04T10:00:00.000Z",
			createdAt: "2026-11-04T10:00:00.000Z",
			...more,
		});
	return { ...selected, sqlite, add };
}

describe.each(["platform-d1", "do-local-sqlite"] as const)(
	"memory store parity: %s",
	(plane) => {
		it("preserves ordinary BM25 recall, lifecycle/privacy fences and public response schema", async () => {
			const { db, add } = fixture(plane);
			await add("match");
			await add("foreign", { organizationId: "fictional-other" });
			await add("private", { visibility: "private", tediId: "other" });
			await add("archived", { archivedAt: scope.now });
			await add("rejected", { reviewStatus: "rejected" });
			const candidates = await lexicalRecall(db, scope, "cobalt workspace");
			expect(candidates.map((row) => row.factId)).toEqual(["match"]);
			expect(candidates[0]!.score).toBeGreaterThan(0);
			const [fact] = await hydrateRecall(
				db,
				scope,
				candidates.map((row) => row.factId),
			);
			expect(
				SearchResultSchema.parse({
					factId: fact!.id,
					score: candidates[0]!.score,
					fact,
				}).factId,
			).toBe("match");
			await recordRecallAccess(db, orgScope, ["match", "foreign"]);
			expect(
				(await db.select().from(memoryFacts)).find((row) => row.id === "match")
					?.accessCount,
			).toBe(1);
			expect(
				(await db.select().from(memoryFacts)).find(
					(row) => row.id === "foreign",
				)?.accessCount,
			).toBe(0);
		});

		it("preserves exact-topic and Relations v2 lookups", async () => {
			const { db, add } = fixture(plane);
			await add("topic", {
				topicKey: "storage/cobalt",
				sourceHash: "hash-cobalt",
			});
			await add("wrong", { topicKey: "storage/cobalt-extra" });
			expect(
				(await findCurrentFactsByTopicKey(db, orgScope, "storage/cobalt")).map(
					(row) => row.id,
				),
			).toEqual(["topic"]);
			expect(
				(await findFactBySourceHash(db, orgScope, "hash-cobalt"))?.id,
			).toBe("topic");
			expect(
				await findFactBySourceHash(
					db,
					{ organizationId: "fictional-other" },
					"hash-cobalt",
				),
			).toBeUndefined();
		});

		it("preserves date-cued recall independently of lexical matching", async () => {
			const { db, add } = fixture(plane);
			await add("yesterday", { content: "Unrelated calendar event" });
			await add("older", { validFrom: "2026-10-01T12:00:00.000Z" });
			expect(
				(await temporalRecall(db, scope, "what changed yesterday")).map(
					(row) => row.factId,
				),
			).toEqual(["yesterday"]);
			expect(
				(await temporalRecall(db, scope, "on 2026-10-01")).map(
					(row) => row.factId,
				),
			).toEqual(["older"]);
		});

		it("keeps entity ownership, reviewed resolution and one-hop graph recall", async () => {
			const { db, add } = fixture(plane);
			const entity = await createMemoryEntity(db, {
				id: "entity",
				organizationId: scope.organizationId,
				entityType: "concept",
				displayName: "  Cobalt Migration ",
				now: scope.now,
			});
			expect(entity.normalizedName).toBe("cobalt migration");
			expect(
				(
					await getMemoryEntity(db, {
						organizationId: scope.organizationId,
						entityId: entity.id,
					})
				)?.id,
			).toBe("entity");
			expect(
				await getMemoryEntity(db, {
					organizationId: "fictional-other",
					entityId: entity.id,
				}),
			).toBeNull();
			await add("seed", { content: "Refinery planning" });
			await add("hop", { content: "Delivery deadline" });
			await add("foreign", {
				content: "Foreign deadline",
				organizationId: "fictional-other",
			});
			await recordMemoryEntityMention(db, {
				id: "mention",
				organizationId: scope.organizationId,
				occurrenceKey: "seed:1",
				sourceFactId: "seed",
				surfaceForm: "Cobalt",
				proposedType: "concept",
				extractor: "fixture",
				extractorVersion: "1",
				confidence: 0.9,
				createdAt: scope.now,
			});
			await proposeMemoryEntityResolution(db, {
				id: "decision",
				organizationId: scope.organizationId,
				clientProposalKey: "proposal",
				mentionId: "mention",
				targetEntityId: entity.id,
				confidence: 0.9,
				rationale: "Exact source identity",
				proposedBy: { type: "external_agent", id: "fictional-proposer" },
				proposedAt: scope.now,
			});
			await reviewMemoryEntityResolutionProposal(db, {
				organizationId: scope.organizationId,
				decisionId: "decision",
				expectedDecisionVersion: 0,
				outcome: "accept",
				reviewer: { type: "user", id: "fictional-reviewer" },
				reviewRationale: "Confirmed fixture identity",
				resolutionId: "resolution",
				reviewedAt: scope.now,
			});
			await expect(
				db.run(sql`INSERT INTO memory_edges(id,source_fact_id,target_fact_id,relation_type)
			VALUES ('foreign-edge','seed','foreign','related_to')`),
			).rejects.toThrow();
			await db.run(sql`INSERT INTO memory_edges(id,source_fact_id,target_fact_id,relation_type)
			VALUES ('edge','seed','hop','related_to')`);
			expect(
				(await graphRecall(db, scope, "Cobalt Migration"))
					.map((row) => row.factId)
					.sort(),
			).toEqual(["hop", "seed"]);
			expect(
				(await lexicalRecall(db, scope, "Cobalt")).map((row) => row.factId),
			).toEqual(["seed"]);
		});

		it("synchronizes citations on insert, update and delete", async () => {
			const { db, add } = fixture(plane);
			await add("source");
			await add("summary", {
				source: "consolidation://observation",
				metadata: {
					consolidation: { evidence: { sources: [{ id: "source" }] } },
				},
			});
			expect(await findCitationDependents(db, orgScope, ["source"])).toEqual([
				"summary",
			]);
			await db.batch([db.update(memoryFacts).set({ metadata: {} })]);
			expect(await findCitationDependents(db, orgScope, ["source"])).toEqual(
				[],
			);
			await db
				.update(memoryFacts)
				.set({
					metadata: {
						consolidation: { evidence: { sources: [{ id: "source" }] } },
					},
				})
				.where(eq(memoryFacts.id, "summary"));
			expect(await findCitationDependents(db, orgScope, ["source"])).toEqual([
				"summary",
			]);
			await db.delete(memoryFacts).where(eq(memoryFacts.id, "summary"));
			expect(await findCitationDependents(db, orgScope, ["source"])).toEqual(
				[],
			);
		});

		it("synchronizes FTS content updates and deletes", async () => {
			const { db, add } = fixture(plane);
			await add("fts");
			await db
				.update(memoryFacts)
				.set({ content: "Amber harbour" })
				.where(eq(memoryFacts.id, "fts"));
			expect(await lexicalRecall(db, scope, "cobalt")).toEqual([]);
			expect(
				(await lexicalRecall(db, scope, "amber")).map((row) => row.factId),
			).toEqual(["fts"]);
			await db.delete(memoryFacts).where(eq(memoryFacts.id, "fts"));
			expect(await lexicalRecall(db, scope, "amber")).toEqual([]);
		});

		it("rechecks auto-link bytes and fences the audit", async () => {
			const { db, auditDb, add } = fixture(plane);
			await add("a");
			await add("b");
			await add("foreign", { organizationId: "fictional-other" });
			const facts = await listAutoLinkFacts(db, {
				organizationId: scope.organizationId,
			});
			expect(facts.map((row) => row.id).sort()).toEqual(["a", "b"]);
			expect(
				await createAutoLinkEdge(
					db,
					{ organizationId: scope.organizationId },
					{
						id: "edge",
						source: facts[0]!,
						target: facts[1]!,
						relationType: "related_to",
						context: "same topic",
					},
				),
			).toBe(true);
			const audit = await auditMemoryGraph(
				{
					db: auditDb,
					organizationId: scope.organizationId,
					tediId: scope.tediId,
				},
				{ scope: "org" },
			);
			expect(audit.counts.total).toBe(2);
			expect(audit.facts.map((row) => row.id).sort()).toEqual(["a", "b"]);
		});

		it("rolls back the complete batch on failure", async () => {
			const { db } = fixture(plane);
			await expect(
				db.batch([
					db.run(
						sql`INSERT INTO memory_facts(id,organization_id,content,fact_type) VALUES ('rollback',${scope.organizationId},'test','technical')`,
					),
					db.run(
						sql`INSERT INTO memory_facts(id,organization_id,content,fact_type) VALUES ('rollback',${scope.organizationId},'duplicate','technical')`,
					),
				]),
			).rejects.toThrow();
			expect(
				await db.all(sql`SELECT id FROM memory_facts WHERE id='rollback'`),
			).toEqual([]);
		});
	},
);
