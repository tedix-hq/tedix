import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { dispatcherHealthReports } from "../schema/dispatcher-health";
import { memoryEdges, memoryFacts } from "../schema/memory-graph";
import { organizations } from "../schema/organizations";
import { organizationMembers } from "../schema/organization-members";
import { principalIdentities } from "../schema/principal-identities";
import { tediRationaleRecords } from "../schema/rationale-records";
import { tedis } from "../schema/tedis";
import { users } from "../schema/users";
import { workItems, workItemRelations } from "../schema/work-items";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	createMachineToolCall,
	claimMachineToolCalls,
	readMachineToolCall,
	listMachines,
	isMachineReporter,
	listMachineToolCallsInRange,
} from "./machines";
import {
	insertOidcRecord,
	consumeOidcLogin,
	resolveOidcSessionContext,
	getOidcOrganization,
	resolveOidcMember,
} from "./oidc-sessions";
import {
	createGraphRetrievalBenchmarkSuite,
	addGraphRetrievalBenchmarkCase,
	lockGraphRetrievalBenchmarkSuite,
	getGraphRetrievalBenchmarkSuite,
	startGraphRetrievalBenchmarkRun,
	recordGraphRetrievalBenchmarkResult,
	completeGraphRetrievalBenchmarkRun,
	startGraphRetrievalBenchmarkRunPair,
	completeEligibleGraphRetrievalBenchmarkRunPair,
} from "./graph-retrieval-benchmarks";
import {
	getGraphRetrievalBenchmarkCaseById,
	listCanonicalBenchmarkFacts,
	listCanonicalBenchmarkEdges,
	getGraphProjectionReadinessSnapshot,
	getLatestGraphRetrievalPairEvaluation,
} from "./graph-retrieval-runtime";
import { auditMemoryGraph } from "./memory-audit";
import { createHistoryReader, HISTORY_TABLES } from "./history-export";
import {
	graphRetrievalBenchmarkCases,
	graphRetrievalBenchmarkSuites,
	graphRetrievalBenchmarkResults,
} from "../schema/graph-retrieval-benchmarks";
import { policyPacks } from "../schema/control-plane";
import {
	modelCatalogConfig,
	modelCatalogEntry,
} from "@tedix/api-contract/test/model-catalog";
import { getModelCatalogConfig } from "./model-catalog";
import { getInstallationTrustPolicy } from "./installation-trust";
import { workEvents } from "../schema/work-items";
import { getKnowledgeMarketReport } from "./knowledge-market";
import { getOrgGraphHealth } from "./org-graph-health";

const at = "2026-11-27T00:00:00.000Z";
for (const store of ["d1", "postgres"] as const) {
	describe(`remaining g-o core queries: ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				})) {
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
				}
			}
			await db.insert(coreTable(db, organizations)).values([
				{
					id: "org",
					name: "Example",
					slug: "example",
					metadata: {
						identityProvider: {
							kind: "oidc",
							issuer: "https://identity.example",
							clientId: "client",
							redirectUri: "https://app.example/callback",
							scopes: ["openid"],
							scopeMapping: {},
							sessionSeconds: 600,
						},
					},
				},
				{ id: "other", name: "Other", slug: "other" },
			]);
			await db.insert(coreTable(db, tedis)).values({
				id: "tedi",
				organizationId: "org",
				name: "Tedi",
				slug: "tedi",
			});
		}, 30_000);
		afterAll(async () => {
			await close?.();
		});

		it("loads trusted policy wrappers from the selected store", async () => {
			const trust = {
				version: 1,
				aggregate: {
					sharedSourceOrganizationIds: ["org"],
					aggregateHostOrganizationIds: ["other"],
				},
			};
			const modelCatalog = modelCatalogConfig([
				modelCatalogEntry("azure-openai/example-custom"),
			]);
			for (const [slug, definition] of [
				["installation-trust", { installationTrust: trust }],
				["model-catalog", { modelCatalog }],
			] as const) {
				await db.insert(coreTable(db, policyPacks)).values({
					id: slug,
					name: slug,
					slug,
					scope: "system",
					target: "shared",
					status: "active",
					version: 1,
					publishedAt: at,
					publishedBy: "test",
					definition,
				});
			}
			expect(await getInstallationTrustPolicy(db)).toEqual(trust);
			expect(await getModelCatalogConfig(db)).toEqual(modelCatalog);
		});

		it("claims and answers only the machine and reporter's own queue", async () => {
			await db.insert(coreTable(db, dispatcherHealthReports)).values({
				orgId: "org",
				reporterId: "reporter",
				executor: "codex",
				lane: "codex",
				running: true,
				machineName: "studio",
				observedAt: at,
				reportedAt: at,
				reportedBy: "owner",
				machineTools: ["read_runner_state"],
			});
			expect(
				await isMachineReporter(db, {
					orgId: "org",
					machineName: "studio",
					reporterId: "reporter",
					reportedBy: "owner",
				}),
			).toBe(true);
			expect((await listMachines(db, { orgId: "org", at }))[0]).toMatchObject({
				machineName: "studio",
				online: true,
			});
			for (const orgId of ["org", "other"])
				await createMachineToolCall(db, {
					id: `call-${orgId}`,
					orgId,
					machineName: "studio",
					tool: "read_runner_state",
					input: "{}",
					requestedBy: { type: "tedi", id: "tedi" },
					at,
				});
			await expect(
				createMachineToolCall(db, {
					id: "oversized",
					orgId: "org",
					machineName: "studio",
					tool: "read_runner_state",
					input: "x".repeat(220001),
					requestedBy: { type: "tedi", id: "tedi" },
					at,
				}),
			).rejects.toThrow();
			const claim = {
				orgId: "org",
				machineName: "studio",
				reporterId: "reporter",
				limit: 10,
				at,
			};
			expect(
				(await claimMachineToolCalls(db, claim)).calls.map((x) => x.id),
			).toEqual(["call-org"]);
			const results = [{ callId: "call-org", ok: true, result: "answer" }];
			expect(
				(
					await claimMachineToolCalls(db, {
						...claim,
						reporterId: "wrong",
						results,
					})
				).stored,
			).toBe(0);
			expect(
				(await claimMachineToolCalls(db, { ...claim, results })).stored,
			).toBe(1);
			expect(
				await readMachineToolCall(db, { orgId: "org", id: "call-org", at }),
			).toMatchObject({ status: "done", result: "answer" });
			expect(
				await readMachineToolCall(db, { orgId: "other", id: "call-org", at }),
			).toBeNull();
			expect(
				await listMachineToolCallsInRange(db, {
					orgId: "org",
					from: at,
					until: "2026-11-28",
					writesOnly: false,
					order: "oldest",
					limit: 10,
				}),
			).toMatchObject([{ id: "call-org", resultChars: 6 }]);
		});

		it("consumes OIDC logins once and resolves only active issuer membership", async () => {
			const expiresAt = Math.floor(Date.now() / 1000) + 600;
			await insertOidcRecord(db, {
				id: "login",
				organizationId: "org",
				kind: "login",
				configDigest: "digest",
				expiresAt,
			});
			expect(await consumeOidcLogin(db, "login", expiresAt - 1)).toMatchObject({
				id: "login",
			});
			expect(
				await consumeOidcLogin(db, "login", expiresAt - 1),
			).toBeUndefined();
			await db
				.insert(coreTable(db, users))
				.values({ id: "user", email: "user@example.test", name: "User" });
			await db.insert(coreTable(db, principalIdentities)).values({
				id: "identity",
				principalType: "user",
				principalId: "user",
				provider: "oidc",
				issuer: "https://identity.example",
				subject: "subject",
			});
			await db.insert(coreTable(db, organizationMembers)).values({
				id: "member",
				organizationId: "org",
				userId: "user",
				descopeUserId: "legacy",
				email: "user@example.test",
				role: "member",
			});
			await insertOidcRecord(db, {
				id: "session",
				organizationId: "org",
				kind: "session",
				subject: "subject",
				configDigest: "digest",
				scopes: ["openid"],
				expiresAt,
			});
			expect(
				await resolveOidcSessionContext(db, "session", expiresAt - 1),
			).toMatchObject({
				session: { id: "session", scopes: ["openid"] },
				member: { userId: "user", role: "member" },
			});
			expect(
				await resolveOidcSessionContext(db, "session", expiresAt),
			).toBeUndefined();
			expect(
				await resolveOidcMember(
					db,
					"other",
					"https://identity.example",
					"subject",
				),
			).toBeUndefined();
			await db
				.update(coreTable(db, organizations))
				.set({ metadata: { retiredAt: at } })
				.where(eq(coreTable(db, organizations).id, "other"));
			expect(await getOidcOrganization(db, "other")).toBeUndefined();
		});

		it("keeps benchmark revision and lock transitions consistent", async () => {
			await createGraphRetrievalBenchmarkSuite(db, {
				id: "suite",
				organizationId: "org",
				name: "Suite",
				version: 1,
				split: "validation",
				createdByType: "system",
				createdById: "test",
				createdAt: at,
			});
			await addGraphRetrievalBenchmarkCase(db, {
				id: "case",
				organizationId: "org",
				suiteId: "suite",
				expectedSuiteRevision: 0,
				caseKey: "one",
				query: "find",
				expectedFactIds: ["fact", "target"],
				anchorFactIds: ["fact"],
				expectedEdges: [
					{
						sourceFactId: "fact",
						targetFactId: "target",
						relationType: "requires",
					},
				],
				expectedPaths: [
					{
						factIds: ["fact", "target"],
						edges: [
							{
								sourceFactId: "fact",
								targetFactId: "target",
								relationType: "requires",
							},
						],
					},
				],
				validAt: at,
				checksum: "case-hash",
				createdAt: at,
			});
			expect(
				await getGraphRetrievalBenchmarkSuite(db, {
					organizationId: "org",
					suiteId: "suite",
				}),
			).toMatchObject({ revision: 1, caseCount: 1 });
			expect(
				await lockGraphRetrievalBenchmarkSuite(db, {
					organizationId: "org",
					suiteId: "suite",
					expectedRevision: 1,
					minimumCaseCount: 1,
					definitionChecksum: "suite-hash",
					lockedAt: at,
				}),
			).toMatchObject({ status: "locked" });
			await expect(
				addGraphRetrievalBenchmarkCase(db, {
					id: "late",
					organizationId: "org",
					suiteId: "suite",
					expectedSuiteRevision: 1,
					caseKey: "late",
					query: "find",
					expectedFactIds: [],
					validAt: at,
					checksum: "late",
					createdAt: at,
				}),
			).rejects.toMatchObject({ reason: "case_conflict" });
			expect(
				await getGraphRetrievalBenchmarkCaseById(db, {
					organizationId: "org",
					caseId: "case",
				}),
			).toMatchObject({ expectedFactIds: ["fact", "target"] });
			expect(
				await getGraphRetrievalBenchmarkCaseById(db, {
					organizationId: "other",
					caseId: "case",
				}),
			).toBeNull();
		});

		it("preserves locked benchmark evidence through run completion", async () => {
			const run = {
				id: "run",
				organizationId: "org",
				suiteId: "suite",
				suiteChecksum: "suite-hash",
				pairedRunKey: "pair",
				variant: "graph" as const,
				retrievalPolicyVersion: "test",
				modelProvider: "none",
				modelId: "test",
				modelVersion: "1",
				seed: 0,
				startedAt: at,
				projectionSnapshot: {
					configured: true,
					healthy: true,
					passesGate: true,
					state: "ready" as const,
					projectionEpoch: "epoch",
					persistedWatermark: 1,
					gdsWatermark: 1,
					gdsEpoch: "epoch",
					nodeMismatchCount: 0,
					edgeMismatchCount: 0,
					lifecycleMismatchCount: 0,
				},
			};
			await expect(
				startGraphRetrievalBenchmarkRun(db, {
					...run,
					id: "bad-run",
					suiteChecksum: "wrong",
				}),
			).rejects.toMatchObject({ reason: "run_conflict" });
			expect(await startGraphRetrievalBenchmarkRun(db, run)).toMatchObject({
				id: "run",
				projectionSnapshot: run.projectionSnapshot,
			});
			await expect(
				db
					.update(coreTable(db, graphRetrievalBenchmarkSuites))
					.set({ name: "changed" })
					.where(eq(coreTable(db, graphRetrievalBenchmarkSuites).id, "suite")),
			).rejects.toThrow();
			await expect(
				db
					.update(coreTable(db, graphRetrievalBenchmarkCases))
					.set({ query: "changed" })
					.where(eq(coreTable(db, graphRetrievalBenchmarkCases).id, "case")),
			).rejects.toThrow();
			const result = {
				id: "result",
				organizationId: "org",
				runId: "run",
				caseId: "case",
				origin: "manual" as const,
				retrievedFactIds: ["fact"],
				metrics: {
					factRecall: 1,
					factPrecision: 1,
					edgeRecall: 1,
					edgePrecision: 1,
					pathValidity: 1,
					expectedPathCoverage: 1,
					temporalAccuracy: 1,
					forbiddenFactRate: 0,
					citationRecall: 0,
					citationPrecision: 1,
					unsupportedInferenceRate: 0,
					answerScore: 0,
				},
				inputTokens: 0,
				outputTokens: 0,
				latencyMs: 1,
				costUsd: 0,
				passed: true,
				createdAt: at,
			};
			expect(
				await recordGraphRetrievalBenchmarkResult(db, result),
			).toMatchObject({ id: "result", retrievedFactIds: ["fact"] });
			expect(
				await completeGraphRetrievalBenchmarkRun(db, {
					organizationId: "org",
					runId: "run",
					completedAt: at,
				}),
			).toMatchObject({ status: "completed", caseCount: 1 });
			await expect(
				recordGraphRetrievalBenchmarkResult(db, {
					...result,
					id: "late-result",
				}),
			).rejects.toThrow();
			await expect(
				db
					.delete(coreTable(db, graphRetrievalBenchmarkResults))
					.where(
						eq(coreTable(db, graphRetrievalBenchmarkResults).id, "result"),
					),
			).rejects.toThrow();
			const common = {
				...run,
				pairedRunKey: "built-pair",
				retrievalPolicyVersion: "anchor-vs-projected-path-expansion-v1",
				harnessVersionId: "builtin:1",
				modelProvider: "none",
				modelId: "deterministic-retrieval-only",
				modelVersion: "1",
				projectionSnapshot: { ...run.projectionSnapshot, certifiedAt: at },
			};
			await startGraphRetrievalBenchmarkRunPair(db, {
				baseline: { ...common, id: "baseline", variant: "baseline" },
				graph: { ...common, id: "graph", variant: "graph" },
			});
			for (const id of ["baseline", "graph"])
				await recordGraphRetrievalBenchmarkResult(db, {
					...result,
					id: `result-${id}`,
					runId: id,
					origin: "builtin",
				});
			const completed = await completeEligibleGraphRetrievalBenchmarkRunPair(
				db,
				{
					organizationId: "org",
					pairedRunKey: "built-pair",
					baselineRunId: "baseline",
					graphRunId: "graph",
					completedAt: at,
				},
			);
			expect(completed.baselineRun).toMatchObject({
				eligible: true,
				status: "completed",
				aggregateMetrics: { caseCount: 1 },
			});
			expect(completed.graphRun).toMatchObject({
				eligible: true,
				status: "completed",
				aggregateMetrics: { caseCount: 1 },
			});
		});

		it("scopes both endpoints of canonical graph retrieval", async () => {
			await db.insert(coreTable(db, memoryFacts)).values([
				{
					id: "fact",
					organizationId: "org",
					tediId: "tedi",
					content: "Core fact",
					factType: "technical",
					metadata: { producer: "test" },
				},
				{
					id: "target",
					organizationId: "org",
					content: "Target",
					factType: "technical",
				},
				{
					id: "foreign",
					organizationId: "other",
					content: "Foreign",
					factType: "technical",
				},
			]);
			await db.insert(coreTable(db, memoryEdges)).values({
				id: "edge",
				sourceFactId: "fact",
				targetFactId: "target",
				relationType: "related_to",
			});
			expect(
				(
					await listCanonicalBenchmarkFacts(db, {
						organizationId: "org",
						factIds: ["fact", "foreign"],
					})
				).map((x) => x.id),
			).toEqual(["fact"]);
			expect(
				await listCanonicalBenchmarkEdges(db, {
					organizationId: "org",
					sourceFactIds: ["fact"],
				}),
			).toEqual([
				{
					sourceFactId: "fact",
					targetFactId: "target",
					relationType: "related_to",
				},
			]);
			expect(
				await listCanonicalBenchmarkEdges(db, {
					organizationId: "other",
					sourceFactIds: ["fact"],
				}),
			).toEqual([]);
			expect(
				await getGraphProjectionReadinessSnapshot(db, "absent"),
			).toBeNull();
			expect(
				await getLatestGraphRetrievalPairEvaluation(db, {
					organizationId: "org",
					pairedRunKey: "absent",
				}),
			).toBeNull();
		});

		it("audits core memory with JSON, substring filters and exact tenant scope", async () => {
			const result = await auditMemoryGraph(
				{ db, organizationId: "org", tediId: "tedi" },
				{ scope: "all", search: "CORE", producer: "test" },
			);
			expect(result.facts.map((x) => x.id)).toEqual(["fact"]);
			expect(result.facts[0]).toMatchObject({
				contentPreview: "Core fact",
				factType: "technical",
				producer: "test",
			});
			expect(result.counts.total).toBe(1);
		});

		it("pages core history under a fixed high-water mark", async () => {
			await db.insert(coreTable(db, workItems)).values({
				id: "history-work",
				orgId: "org",
				title: "History",
				workKind: "coding",
				createdAt: at,
				admissionSpecRevision: "spec-test",
			});
			await db.insert(coreTable(db, workEvents)).values({
				id: "history-event",
				orgId: "org",
				workItemId: "history-work",
				eventType: "comment",
				actorType: "system",
				actorId: "test",
				occurredAt: at,
			});
			const reader = createHistoryReader(db);
			const table = HISTORY_TABLES.find((x) => x.table === "work_events")!;
			const highWater = await reader.highWater(table);
			expect(
				await reader.page(table, {
					organization: "org",
					from: at,
					to: "2026-11-28T00:00:00Z",
					after: 0,
					highWater,
				}),
			).toMatchObject([{ id: "history-event", __rowid: expect.any(Number) }]);
			expect(
				await reader.page(table, {
					organization: "other",
					from: at,
					to: "2026-11-28T00:00:00Z",
					after: 0,
					highWater,
				}),
			).toEqual([]);
		});

		it("reads rationale JSON citations in the knowledge market", async () => {
			await db.insert(coreTable(db, tedis)).values({
				id: "consumer",
				organizationId: "org",
				name: "Consumer",
				slug: "consumer",
			});
			await db.insert(coreTable(db, tediRationaleRecords)).values({
				id: "rationale",
				orgId: "org",
				tediId: "consumer",
				action: "review",
				rationale: "uses fact",
				evidence: { factIds: ["fact"] },
				createdAt: new Date().toISOString(),
			});
			const report = await getKnowledgeMarketReport(db, { orgId: "org" });
			expect(report.orgId).toBe("org");
			expect(
				report.tedis.find((x) => x.tediId === "tedi")?.repute
					.factCitationsByOthers,
			).toBe(1);
		});

		it("walks a dependency chain once and excludes other organizations", async () => {
			await db.insert(coreTable(db, workItems)).values(
				["root", "middle", "leaf"].map((id) => ({
					id,
					orgId: "org",
					title: id,
					workKind: "coding" as const,
					disposition: "accepted" as const,
					accountableOwnerType: "tedi" as const,
					accountableOwnerId: "tedi",
					acceptedAt: at,
					createdAt: at,
					admissionSpecRevision: "spec-test",
				})),
			);
			await db.insert(coreTable(db, workItemRelations)).values([
				{
					id: "root-middle",
					orgId: "org",
					fromWorkItemId: "root",
					toWorkItemId: "middle",
					relationType: "blocks",
					createdAt: at,
				},
				{
					id: "middle-leaf",
					orgId: "org",
					fromWorkItemId: "middle",
					toWorkItemId: "leaf",
					relationType: "blocks",
					createdAt: at,
				},
			]);
			expect(
				(await getOrgGraphHealth(db, { orgId: "org", now: at }))
					.rootBlockers[0],
			).toMatchObject({ id: "root", downstreamBlockedCount: 2 });
			expect(
				(await getOrgGraphHealth(db, { orgId: "other", now: at })).rootBlockers,
			).toEqual([]);
		});
	});
}
