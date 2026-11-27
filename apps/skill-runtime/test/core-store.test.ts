import {
	afterAll,
	beforeAll,
	describe,
	expect,
	mock,
	spyOn,
	test,
} from "bun:test";
import { Database } from "bun:sqlite";
import { AsyncResource } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { createDbClient, type DbClient } from "@tedix/db/client";
import { coreTable } from "@tedix/db/core-store/client";
import * as coreStoreClient from "@tedix/db/core-store/client";
import { coreDb, withCoreStore } from "@tedix/db/core-store/scope";
import { and, eq } from "drizzle-orm";
import { apps } from "@tedix/db/schema/apps";
import { tedis } from "@tedix/db/schema/tedis";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createPGliteFacade } from "@tedix/db/test/pglite-facade";
import { tableDdl } from "@tedix/db/test/schema-ddl";
import {
	skillEntries,
	skillRuns,
	skillWorkflowSources,
	skillRunArtifacts,
	skillRunAdmissionDedup,
} from "@tedix/db/schema/cognitive";
import {
	claimSkillWorkflowAdmissionFence,
	clearSkillRunRestartIntent,
	createSkillRun,
	finalizeAbortedSkillRunRestart,
	getSkillRun,
	getSkillRunArtifactInlineContent,
	getSkillRunArtifactStorageRow,
	getSkillWorkflowAdmissionFence,
	insertSkillRunArtifactOnce,
	listNonTerminalRuns,
	listWorkflowCallReceiptStorage,
	loadSkillRunSnapshot,
	pruneSkillWorkflowAdmissionFences,
	reconcileSkillRun,
	resolveNamespaceSlugs,
	resolveSkillWorkflowMcpGateway,
	releaseSkillWorkflowAdmissionFence,
	reserveSkillRunExecutionEpoch,
	touchSkillRunReconciled,
	updateSkillRunAfterControl,
} from "../src/db";
import {
	claimWorkflowApprovalDecision,
	finalizeWorkflowApprovalDecision,
} from "../src/workflow-approval";
import {
	abortAmbiguousWorkflowRestart,
	bindWorkflowRestartExecutionEpoch,
	claimWorkflowRestart,
	finalizeWorkflowRestart,
	getWorkflowExecutionEpochOutcome,
	hasWorkflowExecutionEpochStarted,
	isWorkflowInstanceRetired,
	recordWorkflowExecutionEpochOutcome,
	recordWorkflowExecutionEpochStarted,
	resolveAcceptedWorkflowRestart,
	retireUnstartedWorkflowRestart,
} from "../src/workflow-restart";
import { encodeWorkflowArtifactPathSegment } from "../src/workflow-path";

let workflowFactory: (input: {
	env: unknown;
	metadata: unknown;
	ctx: unknown;
}) => Promise<{ run(event: unknown, step: unknown): Promise<unknown> }>;
mock.module("cloudflare:workers", () => ({ WorkerEntrypoint: class {} }));
mock.module("@cloudflare/dynamic-workflows", () => ({
	createDynamicWorkflowEntrypoint: (factory: typeof workflowFactory) => {
		workflowFactory = factory;
		return class {};
	},
}));
await import("../src/skill-workflow");

for (const store of ["d1", "postgres"] as const) {
	describe(`skill runtime core store: ${store}`, () => {
		let db: DbClient;
		let binding: D1Database;
		let legacySqlite: Database | undefined;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = new Database(":memory:");
				sqlite.exec(
					"CREATE TABLE organizations(id TEXT PRIMARY KEY); CREATE TABLE memory_domains(id TEXT PRIMARY KEY); INSERT INTO organizations VALUES ('org'),('other');",
				);
				for (const table of [
					apps,
					tedis,
					skillEntries,
					skillRuns,
					skillWorkflowSources,
					skillRunArtifacts,
					skillRunAdmissionDedup,
				]) {
					for (const ddl of tableDdl(table)) sqlite.exec(ddl);
				}
				binding = createD1Facade(sqlite);
				db = createDbClient(binding);
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				// The separately owned epoch and runtime-pin helpers still use D1.
				legacySqlite = new Database(":memory:");
				for (const table of [
					skillRuns,
					skillRunArtifacts,
					skillWorkflowSources,
				]) {
					for (const ddl of tableDdl(table)) legacySqlite.exec(ddl);
				}
				binding = createD1Facade(legacySqlite);
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../packages/db/drizzle-pg", import.meta.url),
					),
				})) {
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
				}
				await fixture.engine.exec(
					"INSERT INTO organizations(id,name,slug) VALUES ('org','Org','org'),('other','Other','other');",
				);
			}
			await db.insert(coreTable(db, tedis)).values({
				id: "tedi",
				organizationId: "org",
				name: "Tedi",
				slug: "tedi",
			});
			await db.insert(coreTable(db, apps)).values({
				id: "gateway",
				organizationId: "org",
				name: "Gateway",
				slug: "org-unified",
				metadata: {
					mcpConfig: {
						aggregateApps: [{ slug: "example" }],
						authMode: "authenticated",
						codeMode: true,
						aggregateTedis: [{ slug: "tedi", namespace: "operator" }],
					},
				},
			});
			await db.insert(coreTable(db, skillEntries)).values({
				id: "skill",
				organizationId: "org",
				title: "Skill",
				content: "Procedure",
				slug: "skill",
				lifecycleState: "active",
			});
		}, 30_000);
		afterAll(async () => {
			await close?.();
			legacySqlite?.close();
		});

		test("seals grounding and terminal evidence across detached Workflow callbacks", async () => {
			const engine = new AsyncResource("workflow-engine");
			const closeStepStore = mock(async () => {});
			const createStore = spyOn(
				coreStoreClient,
				"createCoreStore",
			).mockImplementation(() => ({ db, close: closeStepStore }));
			const env = {
				CORE_STORE: store,
				DB: binding,
				ENVIRONMENT: "production",
				PLATFORM_SERVICE_TOKEN: "example-token",
				WORKER_VERSION: { id: "example-version" },
				SKILL_ARTIFACTS: {},
				LOADER: {
					get: () => ({
						getEntrypoint: () => ({
							run: async () => {
								if (failTenant) throw new Error("tenant failed");
								return { saved: true };
							},
						}),
					}),
				},
			};
			let failTenant = false;
			try {
				for (const outcome of ["completed", "failed"] as const) {
					failTenant = outcome === "failed";
					const runId = `detached-${outcome}`;
					const input = {
						runId,
						skillId: "skill",
						tediId: "tedi",
						orgId: "org",
						workflowInstanceId: runId,
						params: {},
						workflowSource: "export default {}",
						skillDoc: "Procedure",
						skillRevision: 1,
						runtimeEnvironment: "production" as const,
						capabilityManifest: {
							mcp: {},
							network: false,
							rationale: { mode: "off" },
							expectedAnnotations: { destructive: false, readOnly: false },
							grounding: { required: true, minCausalScore: 1, enforce: "warn" },
						},
					};
					await createSkillRun(db, input);
					if (store === "postgres")
						await createSkillRun(createDbClient(binding), input);
					await insertSkillRunArtifactOnce(db, {
						id: `context-${runId}`,
						runId,
						path: "factory/context.json",
						mimeType: "application/json",
						sizeBytes: 4,
						contentInline: "null",
						contentR2Key: null,
						sha256: null,
						attempt: 1,
						outcome: "success",
					});
					const workflow = await workflowFactory({
						env,
						metadata: { runId, skillId: "skill", tediId: "tedi", orgId: "org" },
						ctx: {
							exports: new Proxy({}, { get: () => () => ({}) }),
							waitUntil: () => {},
						},
					});
					const steps: string[] = [];
					const before = closeStepStore.mock.calls.length;
					const result = workflow.run(
						{},
						{
							do(
								name: string,
								optionsOrCallback: unknown,
								callback?: () => Promise<unknown>,
							) {
								steps.push(name);
								return engine.runInAsyncScope(() => {
									if (store === "postgres")
										expect(() => coreDb(env)).toThrow(
											"requires a withCoreStore scope",
										);
									return (
										typeof optionsOrCallback === "function"
											? optionsOrCallback
											: callback!
									)();
								});
							},
						},
					);
					if (failTenant) await expect(result).rejects.toThrow("tenant failed");
					else await expect(result).resolves.toEqual({ saved: true });
					expect(steps).toEqual(
						outcome === "completed"
							? [
									"tedix epoch 0 tool refusal check",
									"tedix epoch 0 grounding policy",
									"tedix epoch 0 completed fence",
								]
							: ["tedix epoch 0 failed fence"],
					);
					if (store === "postgres")
						expect(closeStepStore.mock.calls.length - before).toBe(
							steps.length,
						);
					const { getWorkflowExecutionEpochOutcome } =
						await import("../src/workflow-restart");
					expect(
						await withCoreStore(env, () =>
							getWorkflowExecutionEpochOutcome(binding, runId, 0),
						),
					).toMatchObject({ outcome });
					if (!failTenant)
						expect(
							JSON.parse(
								(await getSkillRunArtifactInlineContent(
									db,
									runId,
									"evidence/policy.json",
								))!,
							),
						).toMatchObject({ verdict: "warn" });
				}
			} finally {
				createStore.mockRestore();
				engine.emitDestroy();
			}
		});

		test("pins snapshots, fences restarts and seals organization-scoped receipts", async () => {
			await createSkillRun(db, {
				runId: "run",
				skillId: "skill",
				tediId: "tedi",
				orgId: "org",
				workflowInstanceId: "run",
				params: { nested: { enabled: true } },
				workflowSource: "export default {}",
				skillDoc: "Procedure",
				skillRevision: 3,
				capabilityManifest: { network: false },
				certification: true,
				runtimeEnvironment: "development",
			});
			expect(await loadSkillRunSnapshot(db, "run")).toMatchObject({
				params: { nested: { enabled: true } },
				skillRevision: 3,
				capabilityManifest: { network: false },
				certification: true,
				workflowSource: "export default {}",
			});
			expect(
				await updateSkillRunAfterControl(db, "run", "queued", {
					restart: true,
					requireAdmissionMarker: true,
					expectedExecutionEpoch: 0,
				}),
			).toBe(true);
			expect(await reserveSkillRunExecutionEpoch(db, "run", 0, "restart")).toBe(
				1,
			);
			expect(
				await reserveSkillRunExecutionEpoch(db, "run", 0, "racing"),
			).toBeNull();
			expect(
				await updateSkillRunAfterControl(db, "run", "queued", {
					restart: true,
					requireRestartIntent: true,
					expectedExecutionEpoch: 0,
				}),
			).toBe(false);
			expect(
				await updateSkillRunAfterControl(db, "run", "queued", {
					restart: true,
					requireRestartIntent: true,
					expectedExecutionEpoch: 1,
				}),
			).toBe(true);
			expect(await clearSkillRunRestartIntent(db, "run", 0)).toBe(false);
			expect(await clearSkillRunRestartIntent(db, "run", 1)).toBe(true);
			expect(
				await reconcileSkillRun(db, "run", {
					status: "paused",
					result: { retained: true },
					expectedExecutionEpoch: 1,
				}),
			).toBe(true);
			expect(await getSkillRun(db, "run", "development")).toMatchObject({
				executionEpoch: 1,
				status: "paused",
			});
			expect(await getSkillRun(db, "run", "production")).toBeNull();
			const runs = coreTable(db, skillRuns);
			const [stored] = await db
				.select({ result: runs.result })
				.from(runs)
				.where(eq(runs.id, "run"));
			expect(stored?.result).toEqual({ retained: true });
			await touchSkillRunReconciled(db, "run");
			expect(
				(await listNonTerminalRuns(db, "development")).map((row) => row.runId),
			).toEqual(["run"]);

			const artifact = {
				id: "receipt",
				runId: "run",
				path: "epochs/1/steps/1/calls/1.json",
				mimeType: "application/json",
				sizeBytes: 2,
				contentInline: "{}",
				contentR2Key: null,
				sha256: "hash",
				attempt: 1,
				outcome: "success",
			};
			expect(await insertSkillRunArtifactOnce(db, artifact)).toBe(true);
			await insertSkillRunArtifactOnce(db, {
				...artifact,
				id: "not-a-receipt",
				path: artifact.path.toUpperCase(),
			});
			expect(
				await insertSkillRunArtifactOnce(db, {
					...artifact,
					id: "duplicate",
					contentInline: "changed",
				}),
			).toBe(false);
			expect(
				await getSkillRunArtifactStorageRow(db, "run", artifact.path),
			).toMatchObject({ id: "receipt", size_bytes: 2 });
			expect(
				await getSkillRunArtifactInlineContent(db, "run", artifact.path),
			).toBe("{}");
			expect(
				await listWorkflowCallReceiptStorage(db, "org", "run", 1, ""),
			).toEqual([
				{ path: artifact.path, content_inline: "{}", content_r2_key: null },
			]);
			expect(
				await listWorkflowCallReceiptStorage(db, "other", "run", 1, ""),
			).toEqual([]);
			expect(
				await listWorkflowCallReceiptStorage(db, "org", "run", 0, ""),
			).toEqual([]);

			expect(await reserveSkillRunExecutionEpoch(db, "run", 1, "abort")).toBe(
				2,
			);
			expect(await finalizeAbortedSkillRunRestart(db, "run", 2, "wrong")).toBe(
				false,
			);
			expect(await finalizeAbortedSkillRunRestart(db, "run", 2, "abort")).toBe(
				true,
			);
			expect(await loadSkillRunSnapshot(db, "run")).toBeNull();
			expect(
				await reserveSkillRunExecutionEpoch(db, "run", 2, "retired"),
			).toBeNull();
		});

		test("admits one deduplicated run and preserves newer claims", async () => {
			const claim = {
				fingerprint: "fingerprint",
				candidateRunId: "one",
				now: "2026-11-27T00:00:00.000Z",
				expiresAt: "2026-11-27T00:01:00.000Z",
			};
			expect(await claimSkillWorkflowAdmissionFence(db, claim)).toMatchObject({
				run_id: "one",
			});
			expect(
				await claimSkillWorkflowAdmissionFence(db, {
					...claim,
					candidateRunId: "two",
				}),
			).toBeNull();
			expect(
				await claimSkillWorkflowAdmissionFence(db, {
					...claim,
					candidateRunId: "two",
					now: claim.expiresAt,
					expiresAt: "2026-11-27T00:02:00.000Z",
				}),
			).toMatchObject({ run_id: "two" });
			await releaseSkillWorkflowAdmissionFence(db, {
				fingerprint: claim.fingerprint,
				runId: "one",
			});
			expect(
				await getSkillWorkflowAdmissionFence(db, claim.fingerprint),
			).toMatchObject({ run_id: "two" });
			await pruneSkillWorkflowAdmissionFences(db, "2026-11-27T00:03:00.000Z");
			expect(
				await getSkillWorkflowAdmissionFence(db, claim.fingerprint),
			).toBeNull();
		});

		test("resolves the owning gateway without crossing organizations", async () => {
			expect(
				await resolveNamespaceSlugs(db, [
					...Array.from({ length: 120 }, (_, index) => `missing-${index}`),
					"org-unified",
				]),
			).toEqual({ "org-unified": "org-unified" });
			expect(await resolveSkillWorkflowMcpGateway(db, "org", "tedi")).toEqual({
				slug: "org-unified",
				tediNamespace: "operator",
			});
			expect(
				await resolveSkillWorkflowMcpGateway(db, "other", "tedi"),
			).toBeNull();
		});

		const seedRun = (
			id: string,
			patch: Partial<typeof skillRuns.$inferInsert> = {},
		) =>
			db.insert(coreTable(db, skillRuns)).values({
				id,
				organizationId: "org",
				skillId: "skill",
				tediId: "tedi",
				workflowInstanceId: id,
				runtimeEnvironment: "development",
				status: "running",
				...patch,
			});
		const setRun = (
			id: string,
			patch: Partial<typeof skillRuns.$inferInsert>,
		) => {
			const runs = coreTable(db, skillRuns);
			return db.update(runs).set(patch).where(eq(runs.id, id));
		};
		const artifactRow = async (runId: string, path: string) => {
			const t = coreTable(db, skillRunArtifacts);
			const [row] = await db
				.select({
					outcome: t.outcome,
					sha256: t.sha256,
					content: t.contentInline,
				})
				.from(t)
				.where(and(eq(t.runId, runId), eq(t.path, path)));
			return row ?? null;
		};

		test("fences epoch start and outcome until the run is retired", async () => {
			await seedRun("epoch-run");
			await recordWorkflowExecutionEpochStarted({
				db,
				runId: "epoch-run",
				executionEpoch: 0,
			});
			await recordWorkflowExecutionEpochStarted({
				db,
				runId: "epoch-run",
				executionEpoch: 0,
			});
			expect(await hasWorkflowExecutionEpochStarted(db, "epoch-run", 0)).toBe(
				true,
			);
			expect(await hasWorkflowExecutionEpochStarted(db, "epoch-run", 1)).toBe(
				false,
			);
			expect(
				(await artifactRow("epoch-run", "epochs/0/started.json"))?.sha256,
			).toMatch(/^[0-9a-f]{64}$/);

			const outcome = { db, runId: "epoch-run", executionEpoch: 0 } as const;
			await recordWorkflowExecutionEpochOutcome({
				...outcome,
				outcome: "completed",
				terminalFingerprint: "out",
			});
			await recordWorkflowExecutionEpochOutcome({
				...outcome,
				outcome: "completed",
				terminalFingerprint: "out",
			});
			await expect(
				recordWorkflowExecutionEpochOutcome({
					...outcome,
					outcome: "completed",
					terminalFingerprint: "other",
				}),
			).rejects.toThrow("WORKFLOW_EPOCH_OUTCOME_CONFLICT");
			await expect(
				recordWorkflowExecutionEpochOutcome({
					...outcome,
					outcome: "failed",
					terminalFingerprint: "out",
				}),
			).rejects.toThrow("WORKFLOW_EPOCH_OUTCOME_CONFLICT");
			expect(
				await getWorkflowExecutionEpochOutcome(db, "epoch-run", 0),
			).toEqual({
				outcome: "completed",
				terminalFingerprint: "out",
			});
			expect(
				await getWorkflowExecutionEpochOutcome(db, "epoch-run", 1),
			).toBeNull();

			// Only the exact legacy markers retire; near misses stay enterable.
			for (const error of [
				"REVOKED_TOKEN_REFRESH_FAILED",
				"revoked: lower case",
			]) {
				await setRun("epoch-run", { error });
				expect(await isWorkflowInstanceRetired(db, "epoch-run")).toBe(false);
			}
			for (const error of ["REVOKED", "REVOKED: privacy cleanup"]) {
				await setRun("epoch-run", { error });
				expect(await isWorkflowInstanceRetired(db, "epoch-run")).toBe(true);
				await expect(
					recordWorkflowExecutionEpochStarted({
						db,
						runId: "epoch-run",
						executionEpoch: 1,
					}),
				).rejects.toThrow("WORKFLOW_INSTANCE_RETIRED");
				await expect(
					recordWorkflowExecutionEpochOutcome({
						...outcome,
						executionEpoch: 1,
						outcome: "failed",
					}),
				).rejects.toThrow("WORKFLOW_INSTANCE_RETIRED");
				await expect(
					claimWorkflowRestart({ db, runId: "epoch-run", restartId: "late" }),
				).rejects.toThrow(/permanently retired/);
			}
			await setRun("epoch-run", {
				error: null,
				workflowRetiredAt: "2026-11-27T00:00:00.000Z",
			});
			expect(await isWorkflowInstanceRetired(db, "epoch-run")).toBe(true);
			expect(await hasWorkflowExecutionEpochStarted(db, "epoch-run", 1)).toBe(
				false,
			);
		});

		test("reserves, accepts and operator-aborts restart receipts", async () => {
			await seedRun("restart-run");
			// Non-JSON restart content is ignored by the JSON-guarded retirement read.
			await insertSkillRunArtifactOnce(db, {
				id: "malformed",
				runId: "restart-run",
				path: "controls/restarts/malformed.json",
				mimeType: "application/json",
				sizeBytes: 3,
				contentInline: "not json",
				contentR2Key: null,
				sha256: null,
				attempt: 1,
				outcome: "pending",
			});
			expect(await isWorkflowInstanceRetired(db, "restart-run")).toBe(false);
			const request = {
				db,
				runId: "restart-run",
				restartId: "operator/restart 1",
				from: { name: "publish", count: 2, type: "do" as const },
			};
			const claim = await claimWorkflowRestart(request);
			expect(claim.deduplicated).toBe(false);
			if (claim.deduplicated) throw new Error("expected a fresh claim");
			await expect(claimWorkflowRestart(request)).rejects.toThrow(
				/ambiguous or in-flight/,
			);
			const bound = await bindWorkflowRestartExecutionEpoch({
				db,
				runId: "restart-run",
				path: claim.path,
				pendingContent: claim.pendingContent,
				executionEpoch: 1,
			});
			await expect(
				bindWorkflowRestartExecutionEpoch({
					db,
					runId: "restart-run",
					path: claim.path,
					pendingContent: claim.pendingContent,
					executionEpoch: 1,
				}),
			).rejects.toThrow(/changed before its execution epoch/);
			await finalizeWorkflowRestart({
				...request,
				path: claim.path,
				pendingContent: bound,
				result: { status: "accepted", executionEpoch: 1 },
			});
			expect((await artifactRow("restart-run", claim.path))?.outcome).toBe(
				"success",
			);
			expect(
				await resolveAcceptedWorkflowRestart({
					db,
					runId: "restart-run",
					executionEpoch: 1,
					executionEpochStarted: false,
				}),
			).toMatchObject({ status: "accepted", executionEpoch: 1 });
			expect(
				await resolveAcceptedWorkflowRestart({
					db,
					runId: "restart-run",
					executionEpoch: 2,
					executionEpochStarted: false,
				}),
			).toBeNull();
			expect((await claimWorkflowRestart(request)).deduplicated).toBe(true);

			// An unknown delivery whose epoch never started is operator-aborted,
			// which permanently retires the instance.
			await seedRun("abort-run");
			const abort = { db, runId: "abort-run", restartId: "abort" };
			const abortClaim = await claimWorkflowRestart(abort);
			if (abortClaim.deduplicated) throw new Error("expected a fresh claim");
			const abortBound = await bindWorkflowRestartExecutionEpoch({
				db,
				runId: "abort-run",
				path: abortClaim.path,
				pendingContent: abortClaim.pendingContent,
				executionEpoch: 1,
			});
			await finalizeWorkflowRestart({
				...abort,
				path: abortClaim.path,
				pendingContent: abortBound,
				result: { status: "unknown", executionEpoch: 1 },
			});
			expect(
				await abortAmbiguousWorkflowRestart({
					...abort,
					executionEpoch: 1,
					reason: "verified",
				}),
			).toEqual({ deduplicated: false });
			expect((await artifactRow("abort-run", abortClaim.path))?.outcome).toBe(
				"failure",
			);
			expect(
				await abortAmbiguousWorkflowRestart({
					...abort,
					executionEpoch: 1,
					reason: "verified",
					dedupeOnly: true,
				}),
			).toEqual({ deduplicated: true });
			expect(await isWorkflowInstanceRetired(db, "abort-run")).toBe(true);
			await expect(
				recordWorkflowExecutionEpochStarted({
					db,
					runId: "abort-run",
					executionEpoch: 1,
				}),
			).rejects.toThrow("WORKFLOW_INSTANCE_RETIRED");
			await expect(
				claimWorkflowRestart({ ...abort, restartId: "next" }),
			).rejects.toThrow(/permanently retired/);

			// Epoch start evidence blocks an abort of the same reserved epoch.
			await seedRun("started-run");
			const started = { db, runId: "started-run", restartId: "started" };
			const startedClaim = await claimWorkflowRestart(started);
			if (startedClaim.deduplicated) throw new Error("expected a fresh claim");
			await bindWorkflowRestartExecutionEpoch({
				db,
				runId: "started-run",
				path: startedClaim.path,
				pendingContent: startedClaim.pendingContent,
				executionEpoch: 1,
			});
			await recordWorkflowExecutionEpochStarted({
				db,
				runId: "started-run",
				executionEpoch: 1,
			});
			await expect(
				abortAmbiguousWorkflowRestart({
					...started,
					executionEpoch: 1,
					reason: "too late",
				}),
			).rejects.toThrow(/receipt changed/);
			expect(await isWorkflowInstanceRetired(db, "started-run")).toBe(false);
		});

		test("retires an unstarted accepted restart atomically", async () => {
			await seedRun("retire-run", {
				executionEpoch: 1,
				restartRequestedAt: "2026-11-27T00:00:00.000Z",
				restartCommandId: "restart-1",
				status: "queued",
			});
			const accepted = JSON.stringify({
				restartId: "restart-1",
				request: { from: null },
				status: "accepted",
				executionEpoch: 1,
				updatedAt: "2026-11-27T00:00:00.000Z",
			});
			await insertSkillRunArtifactOnce(db, {
				id: "retire-accepted",
				runId: "retire-run",
				path: `controls/restarts/${encodeWorkflowArtifactPathSegment("restart-1")}.json`,
				mimeType: "application/json",
				sizeBytes: accepted.length,
				contentInline: accepted,
				contentR2Key: null,
				sha256: null,
				attempt: 1,
				outcome: "success",
			});
			const input = {
				db,
				runId: "retire-run",
				organizationId: "org",
				runtimeEnvironment: "development",
				restartId: "restart-1",
				executionEpoch: 1,
				reason: "Retire only.",
				engine: { status: "errored", observedAt: "2026-11-27T00:01:00.000Z" },
			};
			await expect(
				retireUnstartedWorkflowRestart({ ...input, organizationId: "other" }),
			).rejects.toThrow(/no retirement was claimed/);
			const first = await retireUnstartedWorkflowRestart(input);
			expect(first.deduplicated).toBe(false);
			expect(await isWorkflowInstanceRetired(db, "retire-run")).toBe(true);
			expect(
				(
					await artifactRow(
						"retire-run",
						`controls/restart-retirements/${encodeWorkflowArtifactPathSegment("restart-1")}.json`,
					)
				)?.sha256,
			).toMatch(/^[0-9a-f]{64}$/);
			expect(
				(await retireUnstartedWorkflowRestart({ ...input, engine: null }))
					.deduplicated,
			).toBe(true);
			await expect(
				recordWorkflowExecutionEpochStarted({
					db,
					runId: "retire-run",
					executionEpoch: 1,
				}),
			).rejects.toThrow("WORKFLOW_INSTANCE_RETIRED");

			// Start evidence wins the race: no tombstone and no evidence row.
			await seedRun("raced-run", {
				executionEpoch: 1,
				restartRequestedAt: "2026-11-27T00:00:00.000Z",
				restartCommandId: "restart-1",
				status: "queued",
			});
			await insertSkillRunArtifactOnce(db, {
				id: "raced-accepted",
				runId: "raced-run",
				path: `controls/restarts/${encodeWorkflowArtifactPathSegment("restart-1")}.json`,
				mimeType: "application/json",
				sizeBytes: accepted.length,
				contentInline: accepted,
				contentR2Key: null,
				sha256: null,
				attempt: 1,
				outcome: "success",
			});
			await recordWorkflowExecutionEpochStarted({
				db,
				runId: "raced-run",
				executionEpoch: 1,
			});
			await expect(
				retireUnstartedWorkflowRestart({ ...input, runId: "raced-run" }),
			).rejects.toThrow(/no retirement was claimed/);
			expect(await isWorkflowInstanceRetired(db, "raced-run")).toBe(false);
			expect(
				await artifactRow(
					"raced-run",
					`controls/restart-retirements/${encodeWorkflowArtifactPathSegment("restart-1")}.json`,
				),
			).toBeNull();
		});

		test("reserves and settles one approval decision per active epoch", async () => {
			await seedRun("approval-run");
			const decision = {
				db,
				runId: "approval-run",
				executionEpoch: 0,
				approvalId: "approval 1",
				decision: "approved" as const,
				reason: "verified",
				payload: { reviewer: "operator" },
			};
			const claim = await claimWorkflowApprovalDecision(decision);
			expect(claim.deduplicated).toBe(false);
			await expect(
				claimWorkflowApprovalDecision({ ...decision, reason: "different" }),
			).rejects.toThrow(/different decision/);
			await expect(claimWorkflowApprovalDecision(decision)).rejects.toThrow(
				/ambiguous or in-flight/,
			);
			await expect(
				claimWorkflowApprovalDecision({ ...decision, executionEpoch: 1 }),
			).rejects.toThrow(/execution epoch is not active/);
			const settle = {
				db,
				runId: "approval-run",
				path: claim.path,
				executionEpoch: 0,
				approvalId: "approval 1",
				decision: "approved" as const,
				requestDigest: claim.requestDigest,
				pendingContent: claim.pendingContent!,
				delivered: true,
			};
			await finalizeWorkflowApprovalDecision(settle);
			await finalizeWorkflowApprovalDecision(settle);
			expect((await artifactRow("approval-run", claim.path))?.outcome).toBe(
				"success",
			);
			await expect(
				finalizeWorkflowApprovalDecision({ ...settle, delivered: false }),
			).rejects.toThrow(/receipt changed/);
			expect((await claimWorkflowApprovalDecision(decision)).deduplicated).toBe(
				true,
			);

			await setRun("approval-run", { status: "completed" });
			await expect(
				claimWorkflowApprovalDecision({
					...decision,
					approvalId: "approval 2",
				}),
			).rejects.toThrow(/execution epoch is not active/);
			await setRun("approval-run", {
				status: "running",
				error: "REVOKED: cleanup",
			});
			await expect(
				claimWorkflowApprovalDecision({
					...decision,
					approvalId: "approval 3",
				}),
			).rejects.toThrow(/permanently retired/);
		});
	});
}
