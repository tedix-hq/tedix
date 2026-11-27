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
import { eq } from "drizzle-orm";
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
	});
}
