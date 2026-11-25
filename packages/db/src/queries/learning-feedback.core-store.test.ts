import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { organizations } from "../schema/organizations";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	recordLearningInteraction,
	recordLearningInteractionsBatch,
	listDecisionLearningHistory,
	listLearningInteractionsForReflection,
	listFactoryVerdictEvents,
	getLearningInteractionsByIds,
	attributeLearningFeedback,
	getLearningAttributionsForEvents,
	recordLearningMeasurement,
	getLearningMeasurementsByIds,
	getLearningFeedbackSummary,
	proposeLearningImprovement,
	updateLearningImprovementProposal,
	getLearningImprovementProposal,
} from "./learning-feedback";

for (const store of ["d1", "postgres"] as const)
	describe(`learning feedback ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		const at = "2026-11-20T12:00:00.000Z";
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			}
			await db.insert(coreTable(db, organizations)).values([
				{ id: "org", name: "Org", slug: "org" },
				{ id: "other", name: "Other", slug: "other" },
			]);
		}, 30000);
		afterAll(async () => {
			await close?.();
		});
		const signal = (clientEventId: string, scopeId = "owner") => ({
			organizationId: "org",
			actorType: "user" as const,
			actorId: scopeId,
			clientEventId,
			eventKind: "rejected" as const,
			scopeKind: "personal" as const,
			scopeId,
			surface: "decision_deck",
			occurredAt: at,
			issueKey: "queue",
			metadata: { decisionClass: "factory:example:queue" },
		});

		it("preserves private history and correction fences, including native JSON metadata", async () => {
			const first = await recordLearningInteraction(db, signal("private"));
			expect(
				(await recordLearningInteraction(db, signal("private"))).duplicate,
			).toBe(true);
			await expect(
				recordLearningInteraction(db, {
					...signal("private"),
					actorId: "stranger",
				}),
			).rejects.toThrow(/Idempotency/);
			await recordLearningInteraction(db, signal("stranger", "stranger"));
			await recordLearningInteraction(db, {
				...signal("shared"),
				scopeKind: "organization",
				scopeId: "org",
			});
			expect(
				(
					await listDecisionLearningHistory(db, {
						organizationId: "org",
						personalScopeId: null,
						limit: 20,
					})
				).map((row) => row.clientEventId),
			).toEqual(["shared"]);
			expect(
				(
					await listDecisionLearningHistory(db, {
						organizationId: "org",
						personalScopeId: "owner",
						limit: 20,
					})
				)
					.map((row) => row.clientEventId)
					.sort(),
			).toEqual(["private", "shared"]);
			await recordLearningInteraction(db, {
				...signal("correction"),
				eventKind: "undone",
				metadata: {
					decisionClass: "factory:example:queue",
					learningCorrection: true,
					correctsEventId: first.event.id,
				},
			});
			const reflected = await listLearningInteractionsForReflection(db, {
				organizationId: "org",
				surfaces: ["decision_deck"],
				since: "2026-01-01",
				limit: 20,
			});
			expect(reflected.map((row) => row.clientEventId)).not.toContain(
				"private",
			);
			const verdicts = await listFactoryVerdictEvents(db, {
				organizationId: "org",
				classPrefix: "factory:example:",
				since: "2026-01-01",
				limit: 20,
			});
			expect(verdicts.map((row) => row.clientEventId).sort()).toEqual([
				"correction",
				"shared",
				"stranger",
			]);
		});

		it("records and attributes a large event set atomically and reads it without exceeding D1 parameter limits", async () => {
			const rows = Array.from({ length: 120 }, (_, index) =>
				signal(`batch-${index}`),
			);
			expect(await recordLearningInteractionsBatch(db, rows)).toEqual({
				recorded: 120,
			});
			expect(await recordLearningInteractionsBatch(db, rows)).toEqual({
				recorded: 0,
			});
			const history = await listLearningInteractionsForReflection(db, {
				organizationId: "org",
				surfaces: ["decision_deck"],
				since: "2026-01-01",
				limit: 200,
			});
			const ids = history
				.filter((row) => row.clientEventId.startsWith("batch-"))
				.map((row) => row.id);
			const candidates = [
				...Array.from({ length: 250 }, (_, i) => `missing-${i}`),
				...ids,
			];
			expect(
				await getLearningInteractionsByIds(db, "other", candidates),
			).toEqual([]);
			expect(
				await getLearningInteractionsByIds(db, "org", candidates),
			).toHaveLength(120);
			const input = {
				organizationId: "org",
				clientAttributionId: "attribution",
				feedbackEventIds: ids,
				subjectKind: "harness_version" as const,
				subjectId: "version",
				changeKind: "promoted" as const,
				evidenceRefs: ["trace://example"],
				occurredAt: at,
			};
			const attributed = await attributeLearningFeedback(db, input);
			expect(attributed.created).toBe(120);
			expect((await attributeLearningFeedback(db, input)).duplicates).toBe(120);
			expect(
				await getLearningAttributionsForEvents(db, {
					...input,
					organizationId: "other",
				}),
			).toEqual([]);
			expect(await getLearningAttributionsForEvents(db, input)).toHaveLength(
				120,
			);
			await expect(
				attributeLearningFeedback(db, {
					...input,
					clientAttributionId: "rollback-attribution",
					subjectId: "rollback-version",
					feedbackEventIds: [...ids, "missing-event"],
				}),
			).rejects.toThrow();
			expect(
				await getLearningFeedbackSummary(db, {
					organizationId: "org",
					personalScopeId: "owner",
					subjectKind: "harness_version",
					subjectId: "rollback-version",
				}),
			).toMatchObject({ attributionCount: 0 });
			const measurement = await recordLearningMeasurement(db, {
				organizationId: "org",
				clientMeasurementId: "measurement",
				attributionId: attributed.attributions[0]!.id,
				windowKind: "baseline",
				windowStart: "2026-01-01",
				windowEnd: "2026-01-02",
				opportunityCount: 10,
				recurrenceCount: 3,
				successCount: 7,
			});
			expect(
				(
					await getLearningMeasurementsByIds(db, "org", [
						...candidates,
						measurement.measurement.id,
					])
				)[0]?.opportunityCount,
			).toBe(10);
			const summary = await getLearningFeedbackSummary(db, {
				organizationId: "org",
				personalScopeId: "owner",
				subjectKind: "harness_version",
				subjectId: "version",
			});
			expect(summary).toMatchObject({
				attributionCount: 120,
				baseline: { recurrenceRate: 0.3, successRate: 0.7 },
			});
		});

		it("keeps proposal CAS updates within the tenant, expected state and version", async () => {
			const input = {
				organizationId: "org",
				clientProposalId: "proposal",
				tediId: null,
				scopeKind: "personal" as const,
				scopeId: "owner",
				issueKey: "queue",
				subjectKind: "harness_version" as const,
				subjectId: "version",
				recommendation: "Use the measured version",
				evidenceEventIds: [],
				proposedByType: "user" as const,
				proposedById: "owner",
			};
			const { proposal } = await proposeLearningImprovement(db, input);
			expect((await proposeLearningImprovement(db, input)).duplicate).toBe(
				true,
			);
			const update = {
				organizationId: "org",
				id: proposal.id,
				status: "evaluating" as const,
				fromStatuses: ["proposed" as const],
				expectedUpdatedAt: proposal.updatedAt,
			};
			expect(
				await updateLearningImprovementProposal(db, {
					...update,
					organizationId: "other",
				}),
			).toBeNull();
			expect(
				await updateLearningImprovementProposal(db, {
					...update,
					expectedUpdatedAt: "stale",
				}),
			).toBeNull();
			expect(
				(await updateLearningImprovementProposal(db, update))?.status,
			).toBe("evaluating");
			expect(await updateLearningImprovementProposal(db, update)).toBeNull();
			expect(
				await getLearningImprovementProposal(db, "other", proposal.id),
			).toBeNull();
		});
	});
