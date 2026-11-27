import { eq } from "drizzle-orm";
import { memoryFactCitations } from "../../schema/memory-fact-citations";
import { readMarks } from "../../schema-pg/core";
import { pgTableDdl } from "../../test/pg-schema-ddl";
import { OrganizationMemoryAdapter } from "./memory-adapter";
import {
	decayConfidence,
	archiveLowConfidence,
	invalidateFact,
	promoteFromProbation,
	expireProbation,
	resetCollapsedConfidence,
} from "./fact-lifecycle";
import { getMemoryHealthFindings } from "./health-findings";
import { getTopPlatformFacts } from "./platform-facts";
import {
	createEdge,
	getEdgesForFacts,
	getRelatedFactsForFacts,
	countEdgesForFact,
} from "./edges";
import {
	consolidateMemory,
	listMemoryObservations,
	readConsolidation,
} from "./observations";
import {
	fallbackRecall,
	lexicalRecall,
	graphRecall,
	temporalRecall,
	hydrateRecall,
	recordRecallAccess,
	backfillFactSearch,
} from "./hybrid-recall";
import { memoryEdges, type NewMemoryFact } from "../../schema/memory-graph";
import {
	memoryEntities,
	memoryEntityMentions,
	memoryEntityResolutions,
	memoryEntityResolutionDecisions,
	memoryEntityResolutionHeads,
} from "../../schema/memory-entities";
import {
	listApprovedAgentLessons,
	listCorrectedAgentLessons,
	setAgentLessonTriggers,
} from "./agent-lessons";
import {
	searchFactsWithVisibility,
	countActiveFactsUpTo,
	listPrivateFactsOfTedis,
} from "./fact-search";
import type { JsonValue } from "@tedix/api-contract/schemas/common";
import { listAutoLinkFacts, createAutoLinkEdge } from "./auto-linking";
import {
	backfillFactCitations,
	findCitationDependents,
} from "./fact-citations";
import { insertSessionFeedbackLesson } from "./session-feedback";
import { coreTable } from "../../core-store/client";
import { tedis } from "../../schema/tedis";
import { getOrCreateDomain, getDomainByName, listDomains } from "./domains";
import { browseMemory } from "./browse";
import { getRule, listRules, listRuleMiningGuards } from "./rules";
import { getMemoryHealthExtended } from "./health";
import { getMemoryGraphStats } from "./stats";
import { listGaps, getGapStats } from "./gaps";
import {
	recalculateExpertise,
	getExpertise,
	noteFactLearned,
} from "./expertise";
import {
	createCuriosityItem,
	listCuriosityQueue,
	getNextCuriosityItem,
	updateCuriosityStatus,
} from "./curiosity";
import {
	createOptimizationSignal,
	findOpenOptimizationSignal,
	listOptimizationSignals,
	updateSignalStatus,
	getCompiledPatterns,
	getOptimizationBacklog,
} from "./optimization-signals";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import type { DbClient } from "../../client";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { createPGliteFacade } from "../../test/pglite-facade";
import {
	createFact,
	createFacts,
	findCurrentFactsByTopicKey,
	findFactBySourceHash,
	getFactById,
	getFactsByIds,
	recordFactAccess,
	recordFactUsage,
	recordFactVerification,
	updateFact,
} from "./facts";

for (const store of ["d1", "postgres"] as const)
	describe(store, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			const parents =
				"INSERT INTO organizations(id,name,slug) VALUES ('org','Org','org'),('other','Other','other'),('citations','Citations','citations'),('ports','Ports','ports')";
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				sqlite.exec(parents);
				db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
				await fixture.engine.exec(parents);
				// The migration chain lacks read_marks; use native DDL for query parity.
				for (const ddl of pgTableDdl(readMarks))
					await fixture.engine.exec(
						ddl.replace("CREATE TABLE ", "CREATE TABLE IF NOT EXISTS "),
					);
			}
			await db.insert(coreTable(db, tedis)).values({
				id: "tedi",
				organizationId: "org",
				name: "Tedi",
				slug: "tedi",
			});
		});
		afterAll(async () => {
			await close?.();
		});
		it("preserves adapter CAS, consolidation history, lifecycle writes and edge set reads", async () => {
			const scope = { organizationId: "ports" };
			const memory = new OrganizationMemoryAdapter(db, scope);
			const provenance = {
				actor: { id: "fixture", kind: "agent" as const },
				source: { surface: "fixture" },
			};
			await memory.write({
				key: "adapter-port",
				value: "original",
				provenance,
				review: "approved",
			});
			await memory.write({ key: "adapter-port", value: "updated", provenance });
			expect(
				(await memory.history("adapter-port")).map((r) => r.value),
			).toEqual(["original", "updated"]);
			expect((await memory.list("adapter-")).map((r) => r.key)).toEqual([
				"adapter-port",
			]);
			for (const id of ["source-a", "source-b"])
				await createFact(db, {
					id,
					...scope,
					content: `Evidence ${id}`,
					factType: "technical",
					confidence: 0.8,
					topicKey: "port-topic",
					status: "active",
					visibility: "org",
					memoryScope: "org",
					validFrom: null,
				});
			expect(
				await consolidateMemory(db, scope, { topicKey: "port-topic" }),
			).toMatchObject({ observations: 1, overflow: 0 });
			let observations = await listMemoryObservations(db, scope);
			expect(observations).toHaveLength(2);
			expect(
				readConsolidation(observations[0]!)?.evidence.sources,
			).toHaveLength(2);
			for (const observation of observations) {
				const citations = coreTable(db, memoryFactCitations);
				expect(
					(
						await db
							.select({ id: citations.citedFactId })
							.from(citations)
							.where(eq(citations.consolidatedFactId, observation.id))
					)
						.map((r) => r.id)
						.sort(),
				).toEqual(["source-a", "source-b"]);
			}

			const top = await getTopPlatformFacts(db, scope);
			expect(top.length).toBeGreaterThan(0);
			await invalidateFact(db, scope, "source-a", "withdrawn");
			observations = await listMemoryObservations(db, scope, {
				includeHistory: true,
			});
			expect(observations.some((r) => readConsolidation(r)?.isHistory)).toBe(
				true,
			);
			expect(
				(await getFactById(db, scope, "source-a"))?.metadata,
			).toMatchObject({ invalidationReason: "withdrawn" });
			await createEdge(db, scope, {
				id: "port-edge",
				sourceFactId: "source-a",
				targetFactId: "source-b",
				relationType: "related_to",
			});
			const ids = [
				"source-a",
				...Array.from({ length: 120 }, (_, i) => `missing-${i}`),
			];
			expect((await getEdgesForFacts(db, scope, ids)).map((r) => r.id)).toEqual(
				["port-edge"],
			);
			expect(
				await getEdgesForFacts(db, { organizationId: "other" }, ids),
			).toEqual([]);
			expect(await countEdgesForFact(db, scope, "source-a")).toBe(1);
			expect(
				(await getRelatedFactsForFacts(db, scope, ids))
					.get("source-a")
					?.map((r) => r.id),
			).toEqual(["source-b"]);
			const old = "2024-01-01T00:00:00.000Z";
			await createFact(db, {
				id: "decay-port",
				...scope,
				status: "probation",
				content: "Decay",
				factType: "technical",
				createdAt: old,
				updatedAt: old,
				validFrom: null,
				confidence: 0.8,
			});
			expect(
				await decayConfidence(db, scope, 0.99, 0.1, {
					factIds: ["decay-port"],
				}),
			).toBe(1);
			expect(
				(await getFactById(db, scope, "decay-port"))?.confidence,
			).toBeLessThan(0.8);
			await recordFactAccess(db, scope, "decay-port");
			expect(await promoteFromProbation(db, scope)).toBeGreaterThanOrEqual(1);
			await updateFact(db, scope, "decay-port", { confidence: 0.05 });
			expect(
				await resetCollapsedConfidence(db, scope, 0.8, ["decay-port"]),
			).toBe(1);
			expect(
				await archiveLowConfidence(db, scope, 0.9, { factIds: ["decay-port"] }),
			).toMatchObject({ count: 1, archivedIds: ["decay-port"] });
			await createFact(db, {
				id: "expire-port",
				...scope,
				status: "probation",
				content: "Expire",
				factType: "technical",
				createdAt: old,
				updatedAt: old,
			});
			expect((await expireProbation(db, scope)).expiredIds).toContain(
				"expire-port",
			);
			expect((await getMemoryHealthFindings(db, scope)).findings).toHaveLength(
				5,
			);
		});

		it("recalls current facts across lexical, graph and date paths without exposing held or foreign rows", async () => {
			const scope = {
				organizationId: "org",
				now: "2026-11-26T12:00:00.000Z",
				factTypes: ["technical"],
			};
			const recallRows: (Pick<NewMemoryFact, "id" | "content"> &
				Partial<NewMemoryFact>)[] = [
				{
					id: "recall-old",
					content: "Neptune original",
					createdAt: "2026-11-24T01:00:00.000Z",
				},
				{
					id: "recall-current",
					content: "Neptune updated",
					createdAt: "2026-11-26T01:00:00.000Z",
				},
				{
					id: "recall-held",
					content: "Neptune held",
					metadata: { learningFeed: { evidence: { state: "held" } } },
				},
				{
					id: "recall-private",
					content: "Neptune private",
					visibility: "private" as const,
					tediId: "tedi",
				},
				{
					id: "recall-expired",
					content: "Neptune expired",
					metadata: { expiresAt: "2026-11-25T00:00:00Z" },
				},
				{
					id: "recall-malformed",
					content: "Neptune malformed",
					metadata: { expiresAt: "invalid" },
				},
				{
					id: "recall-foreign",
					content: "Neptune foreign",
					organizationId: "other",
				},
			];
			for (const row of recallRows)
				await createFact(db, {
					organizationId: "org",
					factType: "technical",
					confidence: 0.9,
					visibility: "org",
					validFrom: null,
					...row,
				});
			await db.insert(coreTable(db, memoryEdges)).values({
				id: "recall-replacement",
				sourceFactId: "recall-current",
				targetFactId: "recall-old",
				relationType: "supersedes",
			});
			await db.insert(coreTable(db, memoryEntities)).values({
				id: "recall-entity",
				organizationId: "org",
				displayName: "Ocean",
				normalizedName: "ocean",
				entityType: "concept",
			});
			await db.insert(coreTable(db, memoryEntityMentions)).values({
				id: "recall-mention",
				organizationId: "org",
				sourceFactId: "recall-current",
				surfaceForm: "Ocean",
				normalizedForm: "ocean",
				occurrenceKey: "recall-mention",
				proposedType: "concept",
				extractor: "fixture",
				extractorVersion: "1",
				confidence: 0.9,
			});
			await db.insert(coreTable(db, memoryEntityResolutionDecisions)).values({
				id: "recall-decision",
				organizationId: "org",
				clientProposalKey: "recall-decision",
				operation: "link_mention",
				mentionId: "recall-mention",
				targetEntityId: "recall-entity",
				status: "accepted",
				confidence: 0.9,
				rationale: "fixture",
				proposedByType: "system",
				proposedById: "fixture",
				reviewedByType: "system",
				reviewedById: "reviewer",
				reviewedAt: "2026-11-26",
				appliedAt: "2026-11-26",
				expectedMentionVersion: 0,
				expectedEntityVersion: 0,
				inverse: { entityId: null, resolutionId: null, confidence: null },
			});
			await db.insert(coreTable(db, memoryEntityResolutionHeads)).values({
				mentionId: "recall-mention",
				organizationId: "org",
				currentResolutionId: "recall-resolution",
				currentEntityId: "recall-entity",
				lastDecisionId: "recall-decision",
			});
			await db.insert(coreTable(db, memoryEntityResolutions)).values({
				id: "recall-resolution",
				organizationId: "org",
				mentionId: "recall-mention",
				entityId: "recall-entity",
				status: "active",
				decisionId: "recall-decision",
				resolutionKind: "linked",
				confidence: 0.9,
				validFrom: "2026-11-26",
			});
			await expect(
				db
					.update(coreTable(db, memoryEntityMentions))
					.set({ surfaceForm: "changed" })
					.where(eq(coreTable(db, memoryEntityMentions).id, "recall-mention")),
			).rejects.toThrow();
			await expect(
				db
					.delete(coreTable(db, memoryEntityResolutions))
					.where(
						eq(coreTable(db, memoryEntityResolutions).id, "recall-resolution"),
					),
			).rejects.toThrow();
			await expect(
				db
					.update(coreTable(db, memoryEntityResolutionDecisions))
					.set({ rationale: "changed" })
					.where(
						eq(
							coreTable(db, memoryEntityResolutionDecisions).id,
							"recall-decision",
						),
					),
			).rejects.toThrow();

			const recallIds = (rows: { factId: string }[]) =>
				rows.map((r) => r.factId).filter((id) => id.startsWith("recall-"));
			expect(
				(await fallbackRecall(db, scope))
					.map((r) => r.id)
					.filter((id) => id.startsWith("recall-")),
			).toEqual(["recall-current"]);
			expect(recallIds(await lexicalRecall(db, scope, "Neptune"))).toEqual([
				"recall-current",
			]);
			expect(recallIds(await lexicalRecall(db, scope, "Ocean"))).toEqual([
				"recall-current",
			]);
			expect(recallIds(await graphRecall(db, scope, "ocean"))).toEqual([
				"recall-current",
			]);
			expect(recallIds(await temporalRecall(db, scope, "2026-11-26"))).toEqual([
				"recall-current",
			]);
			const hydrated = await hydrateRecall(db, scope, [
				"recall-current",
				"recall-old",
				"recall-foreign",
				"recall-held",
				"recall-private",
			]);
			expect(hydrated).toHaveLength(1);
			expect(hydrated[0]).toMatchObject({
				id: "recall-current",
				replacesFactIds: ["recall-old"],
				metadata: null,
			});
			expect(
				(
					await hydrateRecall(db, { ...scope, tediId: "tedi" }, [
						"recall-private",
					])
				).map((r) => r.id),
			).toEqual(["recall-private"]);
			await recordRecallAccess(db, scope, [
				"recall-current",
				"recall-current",
				"recall-foreign",
			]);
			await recordRecallAccess(db, scope, ["recall-current"]);
			expect(
				(await getFactById(db, scope, "recall-current"))?.accessCount,
			).toBe(1);
			expect(
				(await getFactById(db, { organizationId: "other" }, "recall-foreign"))
					?.accessCount,
			).toBe(0);
			expect(await backfillFactSearch(db, scope)).toBeGreaterThanOrEqual(0);
		});
		it("preserves tenant isolation, JSON rows and bounded confidence updates for large ID sets", async () => {
			const scope = { organizationId: "org" };
			await createFact(db, {
				id: "foreign",
				organizationId: "other",
				content: "foreign",
				factType: "technical",
				confidence: 0.7,
			});
			await createFacts(
				db,
				scope,
				Array.from({ length: 12 }, (_, i) => ({
					id: `f${i}`,
					organizationId: "org",
					content: `fact ${i}`,
					factType: "technical",
					confidence: i === 0 ? 0.99 : 0.5,
					topicKey: "topic",
					sourceHash: "hash",
					metadata: { example: ["json", i] },
				})),
			);
			expect(await getFactById(db, scope, "foreign")).toBeUndefined();
			expect(await findCurrentFactsByTopicKey(db, scope, "topic")).toHaveLength(
				12,
			);
			expect((await findFactBySourceHash(db, scope, "hash"))?.confidence).toBe(
				0.5,
			);
			const ids = [
				...Array.from({ length: 120 }, (_, i) => `f${i}`),
				"foreign",
			];
			expect(await getFactsByIds(db, scope, ids)).toHaveLength(12);
			await recordFactUsage(db, scope, [...ids, "f0", "f1"], "used");
			let fact = await getFactById(db, scope, "f1");
			expect(fact?.usageCount).toBe(2);
			expect(fact?.confidence).toBeCloseTo(0.5 * 1.02 ** 2);
			expect(fact?.metadata).toEqual({ example: ["json", 1] });
			expect((await getFactById(db, scope, "f0"))?.confidence).toBe(1);
			await updateFact(db, scope, "f1", { confidence: 0.11 });
			await recordFactUsage(db, scope, ["f1", "foreign"], "wrong");
			expect((await getFactById(db, scope, "f1"))?.confidence).toBe(0.1);
			await recordFactVerification(db, scope, "f1", 20);
			await recordFactAccess(db, scope, "f1");
			fact = await getFactById(db, scope, "f1");
			expect(fact?.confidence).toBe(1);
			expect(fact?.accessCount).toBe(1);
			expect(fact?.lastVerifiedAt).toMatch(/^\d{4}-/);
			expect(
				(await getFactById(db, { organizationId: "other" }, "foreign"))
					?.confidence,
			).toBe(0.7);
			await expect(
				updateFact(db, scope, "f1", { organizationId: "other" }),
			).rejects.toThrow("organization cannot change");
		});
		it("keeps rule ownership, JSON history and literal search filters across both stores", async () => {
			const scope = { organizationId: "org" };
			for (const [id, owner] of [
				["rule-river", "river"],
				["rule-peer", "peer"],
				["rule-org", null],
			] as const)
				await createFact(db, {
					id,
					...scope,
					content: "Rule 100%",
					factType: "procedural",
					topicKey: `learning-feed:${id}`,
					visibility: owner ? "private" : "org",
					reviewStatus: "confirmed",
					usePolicy: "can_use_as_instruction",
					metadata: {
						learningFeed: { ownerUserId: owner },
						managedRule: { source: "manual" },
					},
				});
			expect(
				(
					await listRules(db, scope, "river", {
						limit: 20,
						offset: 0,
						state: "active",
					})
				)
					.map((r) => r.id)
					.sort(),
			).toEqual(["rule-org", "rule-river"]);
			const approved = await listApprovedAgentLessons(
				db,
				scope,
				"learning-feed:",
				{ viewerUserId: "river" },
			);
			expect(approved.map((r) => r.id).sort()).toEqual([
				"rule-org",
				"rule-river",
			]);
			const rule = approved.find((r) => r.id === "rule-river")!;
			expect(
				await setAgentLessonTriggers(db, scope, rule, {
					keywords: ["database"],
				}),
			).toBe(true);
			expect(
				await setAgentLessonTriggers(db, scope, rule, { keywords: ["stale"] }),
			).toBe(false);
			expect(await getRule(db, scope, "river", "rule-peer")).toBeNull();
			expect(
				(await listRuleMiningGuards(db, scope, null)).map((r) => r.id),
			).toEqual(["rule-org"]);
			for (const [id, history] of [
				["observation", false],
				["history", true],
			] as const)
				await createFact(db, {
					id,
					...scope,
					content: "100% observed",
					factType: "technical",
					visibility: "org",
					source: "consolidation://observation",
					metadata: { consolidation: { isHistory: history } },
				});
			expect(
				(
					await browseMemory(db, {
						...scope,
						view: "observations",
						search: "100%",
						orderBy: "updated",
						limit: 20,
						offset: 0,
					})
				).facts.map((f) => f.id),
			).toEqual(["observation"]);
			expect(
				(
					await browseMemory(db, {
						...scope,
						view: "observations",
						search: "100_",
						orderBy: "updated",
						limit: 20,
						offset: 0,
					})
				).facts,
			).toEqual([]);
		});

		it("round-trips domain expertise and queue mutations without crossing organizations", async () => {
			const scope = { organizationId: "org" };
			const before = await getMemoryGraphStats(db, scope);
			const domain = await getOrCreateDomain(db, scope, "Testing");
			expect((await getDomainByName(db, scope, "Testing"))?.id).toBe(domain.id);
			expect(await listDomains(db, { organizationId: "other" })).toEqual([]);
			await createFact(db, {
				id: "expertise-fact",
				...scope,
				tediId: "tedi",
				domainId: domain.id,
				content: "Learned",
				factType: "technical",
				confidence: 0.8,
				usageCount: 2,
				accessCount: 1,
			});
			expect(
				await recalculateExpertise(db, scope, "tedi", domain.id),
			).toMatchObject({ factCount: 1, avgConfidence: 0.8 });
			expect(
				(await getExpertise(db, scope, "tedi"))[0]?.competenceScore,
			).toBeCloseTo(1.6);
			expect(
				await noteFactLearned(db, scope, "tedi", domain.id, 0.6),
			).toMatchObject({ factCount: 2, avgConfidence: 0.7 });
			const item = await createCuriosityItem(db, {
				id: "curiosity",
				...scope,
				tediId: "tedi",
				domain: "testing",
				topic: "What next?",
				reason: "A gap was found",
				source: "gap_detection",
			});
			expect((await getNextCuriosityItem(db, scope, "tedi"))?.id).toBe(item.id);
			await updateCuriosityStatus(
				db,
				{ organizationId: "other" },
				item.id,
				"completed",
			);
			expect((await listCuriosityQueue(db, scope))[0]?.status).toBe("queued");
			await updateCuriosityStatus(db, scope, item.id, "completed", {
				factsLearned: 2,
			});
			expect(
				(await listCuriosityQueue(db, scope, { status: "completed" }))[0]
					?.factsLearned,
			).toBe(2);
			const signal = await createOptimizationSignal(db, {
				id: "signal",
				...scope,
				tediId: "tedi",
				type: "compiled_pattern",
				domain: "testing",
				source: "atlas_compilation",
				evidence: ["fact:expertise-fact"],
				suggestedAction: "Check the result",
			});
			expect(
				(
					await findOpenOptimizationSignal(db, {
						...scope,
						tediId: "tedi",
						type: "compiled_pattern",
						domain: "testing",
						evidenceIncludes: ["fact:expertise-fact"],
					})
				)?.id,
			).toBe(signal.id);
			expect(await getCompiledPatterns(db, scope, "tedi")).toEqual([
				"Check the result",
			]);
			expect(
				(await getOptimizationBacklog(db, scope)).map((r) => r.id),
			).toEqual(["signal"]);
			await updateSignalStatus(
				db,
				{ organizationId: "other" },
				"signal",
				"dismissed",
			);
			expect((await listOptimizationSignals(db, scope))[0]?.status).toBe(
				"detected",
			);
			await updateSignalStatus(db, scope, "signal", "completed");
			expect(await getCompiledPatterns(db, scope, "tedi")).toEqual([]);
			await createFact(db, {
				id: "gap",
				...scope,
				domainId: domain.id,
				content: "Unknown",
				factType: "gap",
				metadata: { severity: "high" },
			});
			expect(
				(await listGaps(db, scope, { severity: "high" })).map((r) => r.id),
			).toEqual(["gap"]);
			expect(await getGapStats(db, scope)).toMatchObject({
				totalGaps: 1,
				resolvedGaps: 0,
				byDomain: { Testing: 1 },
				bySeverity: { high: 1 },
			});
			const stats = await getMemoryGraphStats(db, scope);
			expect(stats.totalFacts).toBe(before.totalFacts + 2);
			expect(stats.totalDomains).toBe(before.totalDomains + 1);
			expect(await getMemoryHealthExtended(db, scope)).toMatchObject({
				activeFacts: before.totalFacts + 2,
				totalDomains: before.totalDomains + 1,
				totalGaps: 1,
				curiosityQueue: { queued: 0, exploring: 0, completedTotal: 1 },
			});
		});
		it("rechecks auto-link permissions and source content inside the write", async () => {
			const scope = { organizationId: "org" };
			const domain = await getOrCreateDomain(db, scope, "Links");
			for (const id of ["link-a", "link-b", "link-private"])
				await createFact(db, {
					id,
					...scope,
					domainId: domain.id,
					content: id,
					factType: "technical",
					visibility: id === "link-private" ? "private" : "org",
					reviewStatus: "confirmed",
				});
			const facts = await listAutoLinkFacts(db, {
				...scope,
				domainId: domain.id,
				factIds: ["link-a", "link-b", "link-private"],
			});
			expect(facts.map((f) => f.id).sort()).toEqual(["link-a", "link-b"]);
			const input = {
				id: "auto-edge",
				source: facts.find((f) => f.id === "link-a")!,
				target: facts.find((f) => f.id === "link-b")!,
				relationType: "related_to" as const,
				context: "Same topic",
			};
			expect(
				await createAutoLinkEdge(db, { organizationId: "other" }, input),
			).toBe(false);
			expect(
				await createAutoLinkEdge(db, scope, {
					...input,
					source: { ...input.source, content: "stale content" },
				}),
			).toBe(false);
			expect(await createAutoLinkEdge(db, scope, input)).toBe(true);
			expect(
				await createAutoLinkEdge(db, scope, { ...input, id: "replayed-edge" }),
			).toBe(false);
		});
		it("repairs citation links in idempotent pages and tolerates malformed legacy evidence", async () => {
			const scope = { organizationId: "citations" };
			for (const [id, source, sources] of [
				[
					"citation-a",
					"consolidation://observation",
					[{ id: "source" }, null, 42],
				],
				["citation-b", "consolidation://standing_summary", [{ id: "source" }]],
				["citation-malformed", "consolidation://observation", "invalid"],
			] satisfies [string, string, JsonValue][])
				await createFact(db, {
					id,
					...scope,
					content: id,
					factType: "technical",
					source,
					metadata: {
						consolidation: {
							evidence: { sources },
						},
					},
				});
			await createFact(db, {
				id: "citation-foreign",
				organizationId: "other",
				content: "Foreign",
				factType: "technical",
				source: "consolidation://observation",
				metadata: {
					consolidation: { evidence: { sources: [{ id: "source" }] } },
				},
			});
			expect(
				(await findCitationDependents(db, scope, ["source"])).sort(),
			).toEqual(["citation-a", "citation-b"]);
			let scanned = 0;
			for (let i = 0; i < 4; i++)
				scanned += await backfillFactCitations(db, scope, 1);
			expect(scanned).toBe(3);
			expect(await backfillFactCitations(db, scope)).toBe(0);
			expect(
				(
					await findCitationDependents(db, scope, ["source"], {
						legacyPages: 0,
					})
				).sort(),
			).toEqual(["citation-a", "citation-b"]);
		});
		it("replays feedback IDs without overwriting canonical content or another tenant", async () => {
			const fact = {
				id: "feedback",
				organizationId: "org",
				content: "Original instruction",
				factType: "procedural" as const,
			};
			expect((await insertSessionFeedbackLesson(db, fact)).content).toBe(
				fact.content,
			);
			expect(
				(
					await insertSessionFeedbackLesson(db, {
						...fact,
						content: "Replayed",
					})
				).content,
			).toBe(fact.content);
			await expect(
				insertSessionFeedbackLesson(db, { ...fact, organizationId: "other" }),
			).rejects.toThrow("not persisted");
		});
		it("holds mined lessons whose evidence disappeared and keeps private search fenced", async () => {
			const scope = { organizationId: "org" };
			await createFact(db, {
				id: "mined-missing",
				...scope,
				tediId: "tedi",
				content: "Only use reviewed facts",
				factType: "preference",
				topicKey: "learning-feed:mined",
				reviewStatus: "confirmed",
				usePolicy: "can_use_as_instruction",
				visibility: "private",
				metadata: {
					learningFeed: {
						ownerUserId: "river",
						autoConfirmed: true,
						evidenceEventIds: ["missing-event"],
					},
				},
			});
			expect(
				await listApprovedAgentLessons(db, scope, "learning-feed:mined", {
					viewerUserId: "river",
				}),
			).toEqual([]);
			expect(
				(await getFactById(db, scope, "mined-missing"))?.metadata,
			).toMatchObject({
				learningFeed: {
					ownerUserId: "river",
					evidence: { state: "held", redistillRequestedAt: expect.any(String) },
				},
			});
			expect(
				(
					await listCorrectedAgentLessons(db, scope, "river", "missing-event")
				).map((r) => r.id),
			).toEqual(["mined-missing"]);
			expect(
				await listCorrectedAgentLessons(db, scope, "peer", "missing-event"),
			).toEqual([]);
			expect(
				(
					await listPrivateFactsOfTedis(db, {
						...scope,
						tediIds: ["tedi"],
						terms: ["reviewed"],
						limit: 20,
					})
				).map((r) => r.id),
			).toEqual(["mined-missing"]);
			expect(
				(await searchFactsWithVisibility(db, { ...scope, limit: 500 })).some(
					(r) => r.id === "mined-missing",
				),
			).toBe(false);
			expect(await countActiveFactsUpTo(db, scope, 1)).toEqual({
				count: 1,
				capped: true,
			});
		});
	});
