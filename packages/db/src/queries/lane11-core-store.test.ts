import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable, createCoreStore } from "../core-store/client";
import postgres from "postgres";
import { apps } from "../schema/apps";
import { appCatalog } from "../schema/catalog";
import { appTools } from "../schema/tools";
import { tenantToolPolicyResourceGenerations } from "../schema/tenant-tool-policy";
import {
	filterAppConnectionResourceTools,
	deleteApp,
	getAppById,
	getAppBySlugWithTools,
	getAppsBySlugsWithTools,
	setAppGatewayMembership,
} from "./app-records";
import {
	countAutoSyncBaseApps,
	getAppBySlugForOrg,
	getInheritedAppLogos,
	listApiSyncApps,
	listBaseAppsForCatalogApps,
	listAppReferenceMetadataByIds,
	listAppReferenceMetadataBySlugs,
	listPreviewSourceAppsByIds,
	listPreviewSourceAppsBySlugs,
} from "./apps";
import { getAggregateAppLinkTargets } from "./aggregate-app-links";
import { getAppsWithGatingByIds } from "./app-gating";
import { inferCatalogToolOutputSchemas } from "./tools";
import { organizations } from "../schema/organizations";
import { cmsDomainClaims } from "../schema/cms-domain-claims";
import { cmsRestorePermits } from "../schema/cms-restore-fences";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	getCmsSiteById,
	getCmsSiteByActiveWwwAlias,
	registerCmsSite,
	registerCmsSiteWithinQuota,
	rotateCmsSitePageCacheRevision,
	moveCmsSiteToOrganization,
	pauseCmsSiteUnlessRestoring,
} from "./cms-sites";
import {
	reserveCmsDomainClaim,
	beginCmsDomainProvisioning,
	finishCmsDomainProvisioning,
	activateCmsDomainClaim,
	activateCmsWwwAliasClaim,
	beginRemovingCmsDomainClaim,
} from "./cms-domain-claims";
import {
	closeCmsRestoreFence,
	enterCmsRestorePermit,
	releaseCmsRestoreFence,
	leaveCmsRestorePermit,
	renewCmsRestorePermitLease,
	deleteExpiredCmsRestorePermitLeases,
	claimCmsCaptureCronPause,
	confirmCmsCaptureCronPause,
	assertCmsCaptureCronPause,
	releaseCmsCaptureCronPause,
	getCmsRestoreEpoch,
} from "./cms-restore-fences";
import {
	reserveCmsDeprovisionOperation,
	completeCmsDeprovisionOperation,
} from "./cms-deprovision-operations";

import { organizationSecrets } from "../schema/organization-secrets";
import {
	createAppConfigVersion,
	publishAppConfigVersion,
	activateAppConfigVersion,
	listAppConfigVersions,
} from "./app-config-versions";
import {
	createAppSecret,
	getAppSecret,
	listAppSecrets,
	updateAppSecret,
	deleteAppSecret,
} from "./app-secrets";
import {
	setBinding,
	getBindingsBatch,
	getUniqueSecretIds,
	listBindingsForAdapter,
	fetchAppSecretsForHydration,
	fetchOrgSecretsForHydration,
} from "./app-adapter-secret-bindings";

import {
	AGGREGATE_APPS_PATH,
	CONNECTION_PROVIDER_ID_PATH,
	applyAppReferenceWrites,
	listAppsLinkingToApp,
	listAppsReferencingConnectionProvider,
	listAppsWithAggregateEntriesMissingAppId,
	listAppSlugCandidates,
	listAppToolsByConnectionProvider,
} from "./app-reference-maintenance";

import { tedis } from "../schema/tedis";
import { tediRuntimeEvents } from "../schema/cognitive-runtime";
import {
	insertTediRuntimeEvent,
	listTediRuntimeEventsForRouter,
	findOrphanRuns,
	upsertChatDispatchIdempotency,
	patchOldestQueuedDispatchRunId,
	getMappedDispatchRunId,
	claimTediArtifact,
	markTediArtifactPublished,
	upsertTediArtifact,
	listTediApprovalRequests,
	listRecentKernelRunsForOrganization,
	listTediObservabilityRows,
} from "./cognitive-runtime";

import {
	listPendingOrphanWorkflowCleanups,
	claimOrphanWorkflowCleanup,
	confirmOrphanWorkflowCleanup,
} from "./cognitive-runtime-orphan-cleanup";

import {
	upsertAdapter,
	getEnabledAdapters,
	toggleAdapterEnabled,
	deleteAdapter,
} from "./adapters";

import { connectionInstances } from "../schema/connection-instances";
import {
	memoryDomains,
	memoryFacts,
	tediExpertise,
} from "../schema/memory-graph";
import { tediRationaleRecords } from "../schema/rationale-records";
import {
	upsertItems,
	getItemById,
	searchItems,
	deleteItemsByApp,
	getItemCount,
} from "./items";
import {
	collectAllTediGrowthMetrics,
	createGrowthSnapshot,
	listGrowthSnapshots,
} from "./growth-snapshots";
import {
	listSiteReconciliationOrganizations,
	recordSiteReconciliation,
	getLatestSiteReconciliation,
} from "./site-reconciliation";

import { batchNonEmpty } from "../utils/batch";

import { tenantBundles } from "../schema/tenant-bundles";
import { projects } from "../schema/projects";
import {
	getActiveTenantBundle,
	listPrunableTenantBundles,
	deleteTenantBundleRow,
} from "./tenant-bundles";
import {
	listSiteVersionProjects,
	saveSiteVersionReport,
	findSiteUpgradeWork,
} from "./site-versions";
import {
	listCmsTemplateUpstreamProjects,
	saveCmsTemplateUpstreamReport,
	findOpenCmsTemplateUpstreamWork,
} from "./cms-template-upstream";

import {
	createTemplate,
	applyTemplate,
	updateTemplate,
	deleteTemplate,
	getTemplates,
} from "./templates";
import {
	createJob,
	updateJobStatus,
	updateJobProgress,
	getJobsByApp,
	countJobsByApp,
	cleanupOldJobs,
} from "./jobs";
import { tediPlugins } from "../schema/plugins";
import {
	createPluginInstall,
	getPluginInstall,
	updatePluginInstall,
	createPluginEvent,
	listPluginEvents,
	listPlugins,
} from "./plugins";
import { userConfigs } from "../schema/user-configs";
import {
	savePushConfig,
	listPushConfigs,
	deletePushConfigs,
	hasVisiblePushConversation,
} from "./web-push";
import { getOrganizationModelFallback } from "./model-fallback";
import {
	getEntityImageUrl,
	updateEntityImageUrl,
	listLegacyEntityImagesForPlatform,
} from "./entity-images";

const nativeUrl = process.env.TEST_POSTGRES_URL;
const stores = nativeUrl
	? (["d1", "postgres", "native-postgres"] as const)
	: (["d1", "postgres"] as const);
for (const store of stores) {
	describe(`Lane 11 core store: ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		let nativeConnectionString: string;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite));
				close = () => sqlite.close();
			} else if (store === "native-postgres") {
				const target = new URL(nativeUrl!);
				if (!["localhost", "127.0.0.1", "[::1]"].includes(target.hostname))
					throw new Error("TEST_POSTGRES_URL must be loopback");
				const bootstrap = postgres(target.href, { max: 1, prepare: false });
				const database = `lane11_${crypto.randomUUID().replaceAll("-", "")}`;
				await bootstrap.unsafe(`CREATE DATABASE "${database}"`);
				target.pathname = `/${database}`;
				nativeConnectionString = target.href;
				const core = createCoreStore({
					CORE_STORE: "postgres",
					CORE_HYPERDRIVE: { connectionString: target.href },
				});
				db = core.db;
				const admin = postgres(target.href, {
					max: 1,
					prepare: false,
					onnotice: () => {},
				});
				close = async () => {
					await core.close();
					await admin.end();
					try {
						await bootstrap.unsafe(`DROP DATABASE "${database}"`);
					} finally {
						await bootstrap.end();
					}
				};
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await admin.unsafe(ddl).simple();
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
				{ id: "org", name: "Example", slug: "example" },
				{ id: "other", name: "Other", slug: "other" },
			]);
		}, 30_000);
		afterAll(async () => {
			await close?.();
		});

		it("allocates and activates configuration versions atomically without cross-app writes", async () => {
			const app = coreTable(db, apps);
			await db.insert(app).values([
				{
					id: "version-app",
					organizationId: "org",
					name: "Versions",
					slug: "versions",
					latestConfigVersion: 9,
				},
				{
					id: "other-version-app",
					organizationId: "other",
					name: "Other",
					slug: "versions",
				},
			]);
			const batch = vi.spyOn(db, "batch");
			const first = await createAppConfigVersion(db, {
				appId: "version-app",
				config: { nested: [true, null] },
			});
			expect(first).toMatchObject({
				version: 10,
				status: "draft",
				config: { nested: [true, null] },
			});
			expect(batch).toHaveBeenCalledTimes(1);
			batch.mockClear();
			await expect(
				activateAppConfigVersion(db, {
					appId: "version-app",
					versionId: first.id,
				}),
			).rejects.toThrow("must exist and be published");
			expect(batch).toHaveBeenCalledTimes(1);
			await publishAppConfigVersion(db, {
				appId: "version-app",
				versionId: first.id,
			});
			if (store === "d1") {
				await db.run(
					sql`CREATE TRIGGER reject_activation BEFORE UPDATE OF active_config_version_id ON apps BEGIN SELECT RAISE(ABORT, 'reject activation'); END`,
				);
			} else {
				await db.run(
					sql`CREATE FUNCTION reject_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'reject activation'; END $$`,
				);
				await db.run(
					sql`CREATE TRIGGER reject_activation BEFORE UPDATE OF active_config_version_id ON apps FOR EACH ROW EXECUTE FUNCTION reject_activation()`,
				);
			}
			try {
				await expect(
					activateAppConfigVersion(db, {
						appId: "version-app",
						versionId: first.id,
					}),
				).rejects.toThrow();
				expect(
					(await listAppConfigVersions(db, "version-app"))[0]?.activatedAt,
				).toBeNull();
			} finally {
				await db.run(
					sql.raw(
						store === "d1"
							? "DROP TRIGGER reject_activation"
							: "DROP TRIGGER reject_activation ON apps",
					),
				);
				if (store !== "d1")
					await db.run(sql`DROP FUNCTION reject_activation()`);
			}
			batch.mockClear();
			expect(
				await activateAppConfigVersion(db, {
					appId: "version-app",
					versionId: first.id,
				}),
			).toMatchObject({ activatedAt: expect.any(String) });
			expect(batch).toHaveBeenCalledTimes(1);
			batch.mockRestore();
			await expect(
				activateAppConfigVersion(db, {
					appId: "other-version-app",
					versionId: first.id,
				}),
			).rejects.toThrow();
			const concurrent = await Promise.all([
				createAppConfigVersion(db, { appId: "version-app", config: "first" }),
				createAppConfigVersion(db, { appId: "version-app", config: "second" }),
			]);
			expect(concurrent.map((row) => row.version).sort()).toEqual([11, 12]);
			expect(await listAppConfigVersions(db, "other-version-app")).toEqual([]);
			await expect(
				createAppConfigVersion(db, {
					appId: "missing-version-app",
					config: {},
				}),
			).rejects.toThrow();
			const [parent] = await db
				.select()
				.from(app)
				.where(eq(app.id, "version-app"));
			expect(parent).toMatchObject({
				activeConfigVersionId: first.id,
				latestConfigVersion: 12,
			});
			const [other] = await db
				.select()
				.from(app)
				.where(eq(app.id, "other-version-app"));
			expect(other?.activeConfigVersionId).toBeNull();
		});

		it("hydrates bound secret sets once, preserving app and organization isolation", async () => {
			await db.insert(coreTable(db, apps)).values([
				{
					id: "secret-app",
					organizationId: "org",
					name: "Secrets",
					slug: "secrets",
				},
				{
					id: "other-secret-app",
					organizationId: "other",
					name: "Other secrets",
					slug: "secrets",
				},
			]);
			const adapter = await upsertAdapter(db, {
				id: "secret-adapter",
				appId: "secret-app",
				name: "Secrets",
				adapterType: "custom",
				config: {
					baseUrl: "https://example.test",
					endpoints: { search: "/search" },
				},
				priority: null,
			});
			expect(
				await upsertAdapter(db, {
					id: adapter.id,
					appId: "secret-app",
					name: "Renamed",
					adapterType: "custom",
					priority: 1,
				}),
			).toMatchObject({
				id: adapter.id,
				name: "Renamed",
				createdAt: adapter.createdAt,
				config: {
					baseUrl: "https://example.test",
					endpoints: { search: "/search" },
				},
			});
			expect(await getEnabledAdapters(db, "secret-app")).toMatchObject([
				{ id: adapter.id },
			]);
			await toggleAdapterEnabled(db, adapter.id, false);
			expect(await getEnabledAdapters(db, "secret-app")).toEqual([]);
			const secret = await createAppSecret(db, {
				appId: "secret-app",
				name: "TOKEN",
				encryptedValue: "ciphertext",
				hint: "hint",
			});
			const other = await createAppSecret(db, {
				appId: "other-secret-app",
				name: "TOKEN",
				encryptedValue: "other-ciphertext",
			});
			expect(await getAppSecret(db, "secret-app", "TOKEN")).toEqual(secret);
			expect((await listAppSecrets(db, "secret-app"))[0]).not.toHaveProperty(
				"encryptedValue",
			);
			expect(
				await updateAppSecret(db, secret.id, {
					encryptedValue: "rotated",
					keyVersion: 2,
				}),
			).toMatchObject({ encryptedValue: "rotated", keyVersion: 2 });
			await db.insert(coreTable(db, organizationSecrets)).values([
				{
					id: "org-secret",
					organizationId: "org",
					name: "TOKEN",
					encryptedValue: "org-ciphertext",
					createdAt: "now",
					updatedAt: "now",
				},
				{
					id: "other-org-secret",
					organizationId: "other",
					name: "TOKEN",
					encryptedValue: "other",
					createdAt: "now",
					updatedAt: "now",
				},
			]);
			await setBinding(
				db,
				"secret-adapter",
				"secret-app",
				"auth.token",
				secret.id,
				"app",
			);
			await setBinding(
				db,
				"secret-adapter",
				"secret-app",
				"auth.org",
				"org-secret",
				"organization",
			);
			expect(await listBindingsForAdapter(db, "secret-adapter")).toMatchObject([
				{ secretName: "TOKEN" },
				{ secretName: "TOKEN" },
			]);
			const candidates = Array.from(
				{ length: 250 },
				(_, i) => `absent-secret-${i}`,
			);
			const select = vi.spyOn(db, "select");
			try {
				expect(
					(
						await getBindingsBatch(db, [
							...candidates,
							"secret-adapter",
							"secret-adapter",
						])
					).get("secret-adapter"),
				).toHaveLength(2);
				expect(select).toHaveBeenCalledTimes(1);
				select.mockClear();
				expect(
					await getUniqueSecretIds(db, [...candidates, "secret-adapter"]),
				).toEqual({ appSecretIds: [secret.id], orgSecretIds: ["org-secret"] });
				expect(select).toHaveBeenCalledTimes(1);
				select.mockClear();
				expect(
					await fetchAppSecretsForHydration(db, "secret-app", [
						...candidates,
						secret.id,
						other.id,
						secret.id,
					]),
				).toEqual([{ id: secret.id, encryptedValue: "rotated" }]);
				expect(select).toHaveBeenCalledTimes(1);
				select.mockClear();
				expect(
					await fetchOrgSecretsForHydration(db, "org", [
						...candidates,
						"org-secret",
						"other-org-secret",
					]),
				).toEqual([{ id: "org-secret", encryptedValue: "org-ciphertext" }]);
				expect(select).toHaveBeenCalledTimes(1);
			} finally {
				select.mockRestore();
			}
			await deleteAdapter(db, adapter.id);
			expect(await getBindingsBatch(db, [adapter.id])).toEqual(new Map());
			expect(await deleteAppSecret(db, secret.id)).toBe(true);
			expect(await deleteAppSecret(db, secret.id)).toBe(false);
			expect(
				await updateAppSecret(db, secret.id, { hint: "missing" }),
			).toBeUndefined();
		});

		it("repairs references in one batch and rolls every write back for a stale token", async () => {
			const app = coreTable(db, apps);
			const tool = coreTable(db, appTools);
			await db.insert(app).values({
				id: "reference-app",
				organizationId: "org",
				name: "References",
				slug: "references",
				metadata: {
					mcpConfig: {
						aggregateApps: [{ slug: "target" }],
						connectionProviderId: "old",
					},
					keep: true,
				},
			});
			await db.insert(tool).values({
				id: "reference-tool",
				appId: "reference-app",
				toolTypeId: "mcp",
				toolId: "read",
				title: "Read",
				config: { auth: { connectionId: "old" }, keep: true },
			});
			const [scan] = await listAppsWithAggregateEntriesMissingAppId(db, {
				organizationId: "org",
			});
			expect(scan).toMatchObject({
				id: "reference-app",
				connectionProviderId: "old",
			});
			expect(JSON.parse(scan!.aggregateAppsJson!)).toEqual([
				{ slug: "target" },
			]);
			expect(
				await listAppsLinkingToApp(db, { appId: "absent", slug: "target" }),
			).toMatchObject([{ id: "reference-app" }]);
			expect(
				await listAppsReferencingConnectionProvider(db, "old", {
					organizationId: "other",
				}),
			).toEqual([]);
			expect(await listAppToolsByConnectionProvider(db, "old")).toMatchObject([
				{ id: "reference-tool", connectionId: "old" },
			]);
			const select = vi.spyOn(db, "select");
			expect(
				(
					await listAppSlugCandidates(db, [
						...Array.from({ length: 250 }, (_, i) => `absent-${i}`),
						"references",
					])
				).get("references"),
			).toMatchObject([{ id: "reference-app" }]);
			expect(select).toHaveBeenCalledTimes(1);
			select.mockRestore();
			const batch = vi.spyOn(db, "batch");
			try {
				await applyAppReferenceWrites(db, [
					{
						kind: "app_metadata",
						appId: "reference-app",
						path: AGGREGATE_APPS_PATH,
						before: scan!.aggregateAppsJson,
						after: JSON.stringify([{ slug: "target", appId: "target-id" }]),
						afterIsJson: true,
					},
					{
						kind: "app_metadata",
						appId: "reference-app",
						path: CONNECTION_PROVIDER_ID_PATH,
						before: "old",
						after: "new",
						afterIsJson: false,
					},
					{
						kind: "app_tool_connection",
						toolRowId: "reference-tool",
						before: "old",
						after: "new",
					},
					{
						kind: "app_slug",
						appId: "reference-app",
						before: "references",
						after: "renamed-references",
					},
				]);
				expect(batch).toHaveBeenCalledTimes(1);
			} finally {
				batch.mockRestore();
			}
			const [changed] = await db
				.select()
				.from(app)
				.where(eq(app.id, "reference-app"));
			expect(changed?.metadata).toEqual({
				keep: true,
				mcpConfig: {
					aggregateApps: [{ slug: "target", appId: "target-id" }],
					connectionProviderId: "new",
				},
			});
			expect(await listAppToolsByConnectionProvider(db, "new")).toMatchObject([
				{ id: "reference-tool" },
			]);
			await expect(
				applyAppReferenceWrites(db, [
					{
						kind: "app_slug",
						appId: "reference-app",
						before: "renamed-references",
						after: "must-rollback",
					},
					{
						kind: "app_tool_connection",
						toolRowId: "reference-tool",
						before: "stale",
						after: "must-rollback",
					},
				]),
			).rejects.toThrow();
			expect(
				(await db.select().from(app).where(eq(app.id, "reference-app")))[0],
			).toEqual(changed);
			await expect(
				applyAppReferenceWrites(db, [
					{
						kind: "app_metadata",
						appId: "reference-app",
						path: CONNECTION_PROVIDER_ID_PATH,
						before: "stale",
						after: "bad",
						afterIsJson: false,
					},
				]),
			).rejects.toThrow();
		});

		it("reads runtime run sets once and preserves orphan and immutable artifact ownership", async () => {
			await db.insert(coreTable(db, tedis)).values([
				{
					id: "runtime-tedi",
					organizationId: "org",
					name: "Runtime",
					slug: "runtime",
				},
				{
					id: "other-runtime-tedi",
					organizationId: "other",
					name: "Runtime",
					slug: "other-runtime",
				},
			]);
			const scope = { organizationId: "org", tediId: "runtime-tedi" };
			const at = "2026-11-25T00:00:00.000Z";
			await insertTediRuntimeEvent(db, {
				...scope,
				id: "runtime-start",
				runId: "orphan-run",
				conversationId: "conversation",
				kind: "run.started",
				runtimeBackend: "cloudflare-agents",
				createdAt: at,
			});
			await insertTediRuntimeEvent(db, {
				...scope,
				id: "runtime-success",
				runId: "orphan-run",
				kind: "message.completed",
				payload: { status: "ok" },
				runtimeBackend: "cloudflare-agents",
				createdAt: at,
			});
			await insertTediRuntimeEvent(db, {
				...scope,
				id: "runtime-other-run",
				runId: "second-run",
				kind: "tool.completed",
				payload: { count: 1 },
				runtimeBackend: "cloudflare-agents",
				createdAt: at,
			});
			await insertTediRuntimeEvent(db, {
				organizationId: "other",
				tediId: "other-runtime-tedi",
				id: "runtime-wrong-tenant",
				runId: "orphan-run",
				kind: "run.completed",
				runtimeBackend: "cloudflare-agents",
				createdAt: at,
			});
			const select = vi.spyOn(db, "select");
			try {
				expect(
					await listTediRuntimeEventsForRouter(db, {
						...scope,
						runIds: [
							...Array.from({ length: 250 }, (_, i) => `absent-run-${i}`),
							"orphan-run",
							"second-run",
							"orphan-run",
						],
						order: "asc",
						limit: 10,
					}),
				).toMatchObject([
					{ id: "runtime-other-run" },
					{ id: "runtime-start" },
					{ id: "runtime-success" },
				]);
				expect(select).toHaveBeenCalledTimes(1);
			} finally {
				select.mockRestore();
			}
			expect(
				await findOrphanRuns(db, {
					organizationId: "org",
					now: new Date("2026-11-25T01:00:00.000Z"),
				}),
			).toMatchObject([{ runId: "orphan-run", succeededLost: true }]);
			await insertTediRuntimeEvent(db, {
				...scope,
				id: "runtime-terminal",
				runId: "orphan-run",
				kind: "run.completed",
				runtimeBackend: "cloudflare-agents",
				createdAt: at,
			});
			expect(
				await findOrphanRuns(db, {
					organizationId: "org",
					now: new Date("2026-11-25T01:00:00.000Z"),
				}),
			).toEqual([]);
			expect(
				(
					await db
						.select()
						.from(coreTable(db, tediRuntimeEvents))
						.where(eq(coreTable(db, tediRuntimeEvents).id, "runtime-start"))
				)[0]?.terminalSeen,
			).toBe(1);
			await upsertChatDispatchIdempotency(db, {
				...scope,
				idempotencyKey: "runtime-dispatch",
				conversationId: "conversation",
				createdAt: at,
			});
			const patch = {
				tediId: scope.tediId,
				conversationId: "conversation",
				runId: "patched-run",
				cutoff: "2026-11-24T23:59:00.000Z",
				mappedAt: at,
			};
			expect(await patchOldestQueuedDispatchRunId(db, patch)).toBe(1);
			expect(await patchOldestQueuedDispatchRunId(db, patch)).toBe(0);
			expect(
				await getMappedDispatchRunId(db, {
					tediId: scope.tediId,
					idempotencyKey: "runtime-dispatch",
				}),
			).toBe("patched-run");
			const artifact = {
				...scope,
				id: "runtime-artifact",
				kind: "file" as const,
				name: "result.txt",
				uri: "r2://example/result",
				contentDigest: "digest",
				accessClassification: "runtime_private" as const,
				publicationState: "pending" as const,
				metadata: { longerKey: true, a: { z: 1, b: 2 } },
			};
			expect(await claimTediArtifact(db, artifact)).toMatchObject({
				created: true,
			});
			expect(await claimTediArtifact(db, artifact)).toMatchObject({
				created: false,
			});
			await expect(
				claimTediArtifact(db, {
					...artifact,
					tediId: "other-runtime-tedi",
					organizationId: "other",
				}),
			).rejects.toThrow("owned by another tedi");
			await expect(
				upsertTediArtifact(db, { ...artifact, name: "overwrite" }),
			).rejects.toThrow("owned by another tedi");
			expect(
				await markTediArtifactPublished(db, {
					...scope,
					id: artifact.id,
					contentDigest: "wrong",
				}),
			).toBeNull();
			expect(
				await markTediArtifactPublished(db, {
					...scope,
					id: artifact.id,
					contentDigest: "digest",
				}),
			).toMatchObject({ publicationState: "ready" });
			expect(
				await listTediApprovalRequests(db, {
					...scope,
					status: "pending",
					limit: 5,
				}),
			).toEqual([]);
			expect(
				await listRecentKernelRunsForOrganization(db, {
					organizationId: "org",
					limit: 5,
				}),
			).toEqual([]);
			expect(
				await listTediObservabilityRows(db, {
					...scope,
					from: at,
					to: "2026-11-26T00:00:00.000Z",
					limit: 2,
				}),
			).toMatchObject({
				runtimeEvents: [{ id: "runtime-terminal" }, { id: "runtime-success" }],
				runtimeTruncated: true,
			});
		});

		it("claims cleanup once, observes retry expiry and retains a durable confirmation", async () => {
			const scope = { organizationId: "org", tediId: "runtime-tedi" };
			const now = new Date("2026-11-25T02:00:00.000Z");
			await insertTediRuntimeEvent(db, {
				...scope,
				id: "cleanup-failure",
				runId: "runtime-tedi:mcp:cleanup",
				kind: "run.failed",
				runtimeBackend: "cloudflare-agents",
				runtimeMetadata: {
					source: "scheduled.sweepOrphanRuns",
					reason: "runtime_dropped",
				},
				createdAt: now.toISOString(),
			});
			const [item] = await listPendingOrphanWorkflowCleanups(db, now);
			expect(item).toMatchObject({ terminalEventId: "cleanup-failure" });
			if (!item) throw new Error("Missing cleanup candidate");
			expect(
				await claimOrphanWorkflowCleanup(
					db,
					{ ...item, organizationId: "other" },
					now,
				),
			).toBe(false);
			expect(await claimOrphanWorkflowCleanup(db, item, now)).toBe(true);
			expect(await claimOrphanWorkflowCleanup(db, item, now)).toBe(false);
			expect(await listPendingOrphanWorkflowCleanups(db, now)).toEqual([]);
			const later = new Date(now.getTime() + 11 * 60_000);
			expect(await listPendingOrphanWorkflowCleanups(db, later)).toHaveLength(
				1,
			);
			await confirmOrphanWorkflowCleanup(db, item, "terminated");
			await confirmOrphanWorkflowCleanup(db, item, "terminated");
			expect(await listPendingOrphanWorkflowCleanups(db, later)).toEqual([]);
		});

		it("filters large provider/instance sets with two tenant reads and no user-scope reads", async () => {
			const ids = Array.from({ length: 120 }, (_, i) => `policy-provider-${i}`);
			await db.batch(
				batchNonEmpty(
					ids.map((id) =>
						db.insert(coreTable(db, connectionInstances)).values({
							id,
							providerId: id,
							ownerUserId: "user",
							organizationId: "org",
							label: id,
							tokenIds: [],
							createdAt: "now",
							updatedAt: "now",
						}),
					),
				),
			);
			const tools = ids.map((id) => ({
				id,
				config: {
					transport: "mcp" as const,
					auth: {
						type: "connection" as const,
						connectionId: id,
						connectionInstanceId: id,
					},
				},
			}));
			const missing = {
				id: "missing",
				config: {
					auth: {
						type: "connection" as const,
						connectionId: ids[0]!,
						connectionInstanceId: "absent",
					},
				},
			};
			const user = {
				id: "user",
				config: {
					auth: { ...missing.config.auth, credentialScope: "user" as const },
				},
			};
			const wrongPair = {
				id: "wrong-pair",
				config: {
					auth: { ...missing.config.auth, connectionInstanceId: ids[1]! },
				},
			};
			const select = vi.spyOn(db, "select");
			try {
				expect(
					await filterAppConnectionResourceTools(
						db,
						{ organizationId: "org", metadata: null },
						[...tools, missing, user, wrongPair],
					),
				).toEqual([...tools, user]);
				expect(select).toHaveBeenCalledTimes(2);
				select.mockClear();
				expect(
					await filterAppConnectionResourceTools(
						db,
						{ organizationId: "other", metadata: null },
						[tools[0]!, user],
					),
				).toEqual([user]);
				expect(select).toHaveBeenCalledTimes(2);
				select.mockClear();
				expect(
					await filterAppConnectionResourceTools(
						db,
						{ organizationId: "missing", metadata: null },
						[user],
					),
				).toEqual([user]);
				expect(select).not.toHaveBeenCalled();
			} finally {
				select.mockRestore();
			}
		});

		it("batches item imports in order, retaining successes around conflicts and isolating apps", async () => {
			await db.insert(coreTable(db, apps)).values([
				{ id: "item-app", organizationId: "org", name: "Items", slug: "items" },
				{
					id: "foreign-item-app",
					organizationId: "other",
					name: "Items",
					slug: "items",
				},
			]);
			const batch = vi.spyOn(db, "batch");
			try {
				expect(
					await upsertItems(db, "item-app", [
						{
							id: "item-first",
							externalId: "external",
							title: "First",
							vertical: "ecommerce",
							url: "https://example.test/first",
							metadata: { nested: [true, null] },
						},
						{
							id: "item-updated",
							externalId: "external",
							title: "Updated",
							vertical: "ecommerce",
						},
						{
							id: "item-conflict",
							externalId: "conflict",
							title: "Conflict",
							vertical: "ecommerce",
							url: "https://example.test/first",
						},
						...Array.from({ length: 120 }, (_, i) => ({
							id: `bulk-item-${i}`,
							title: `ÄLPHA product ${i}`,
							vertical: "ecommerce",
						})),
					]),
				).toEqual({
					inserted: 121,
					updated: 1,
					errors: [expect.stringContaining('"Conflict"')],
				});
				expect(batch).toHaveBeenCalledTimes(1);
			} finally {
				batch.mockRestore();
			}
			expect((await getItemById(db, "item-updated"))?.metadata).toEqual({
				nested: [true, null],
			});
			expect(await searchItems(db, "item-app", "älpha")).toEqual([]);
			expect(
				await searchItems(db, "item-app", "Älpha", { limit: 150 }),
			).toHaveLength(120);
			expect(
				await upsertItems(db, "foreign-item-app", [
					{
						id: "foreign-item",
						externalId: "external",
						title: "Foreign",
						vertical: "ecommerce",
					},
				]),
			).toMatchObject({ inserted: 1, updated: 0 });
			expect(await getItemCount(db, "item-app")).toBe(121);
			expect(await deleteItemsByApp(db, "item-app")).toBe(121);
			expect(await getItemCount(db, "foreign-item-app")).toBe(1);
		});

		it("collects growth metrics with bounded sets, numeric results and structured snapshots", async () => {
			const rows = Array.from({ length: 120 }, (_, i) => ({
				id: `growth-tedi-${i}`,
				organizationId: "org",
				name: "Growth",
				status: "active" as const,
				slug: `growth-${i}`,
			}));
			await db.batch(
				batchNonEmpty(
					rows.map((row) => db.insert(coreTable(db, tedis)).values(row)),
				),
			);
			await db
				.insert(coreTable(db, memoryDomains))
				.values({ id: "growth-domain", organizationId: "org", name: "Growth" });
			await db.insert(coreTable(db, memoryFacts)).values([
				{
					id: "growth-fact",
					organizationId: "org",
					tediId: "growth-tedi-0",
					content: "Example",
					factType: "technical",
					confidence: 0.8123,
				},
				{
					id: "growth-archived",
					organizationId: "org",
					tediId: "growth-tedi-0",
					content: "Old",
					factType: "technical",
					confidence: 0.2,
					archivedAt: "2026-11-25",
				},
			]);
			await db.insert(coreTable(db, tediExpertise)).values({
				id: "growth-expertise",
				tediId: "growth-tedi-0",
				domainId: "growth-domain",
				expertiseLevel: "expert",
			});
			await db.insert(coreTable(db, tediRationaleRecords)).values({
				id: "growth-rationale",
				tediId: "growth-tedi-0",
				orgId: "org",
				action: "read",
				rationale: "Example",
				runId: "growth-run",
				createdAt: "2026-11-26T00:00:00Z",
			});
			const batch = vi.spyOn(db, "batch");
			let collected: Awaited<ReturnType<typeof collectAllTediGrowthMetrics>>;
			try {
				collected = await collectAllTediGrowthMetrics(db, "2026-11-26");
				expect(batch).toHaveBeenCalledTimes(1);
				expect(batch.mock.calls[0]![0]).toHaveLength(2);
			} finally {
				batch.mockRestore();
			}
			const first = collected.find((row) => row.tediId === "growth-tedi-0")!;
			expect(first.metrics).toEqual({
				facts: 1,
				avgConfidence: 0.812,
				skills: 0,
				avgRevision: 0,
				muscles: 0,
				avgUsage: 0,
				domains: 1,
				autonomyRate: 1,
				expertiseLevels: { "growth-domain": "expert" },
			});
			expect(
				collected.filter((row) => row.tediId.startsWith("growth-tedi-")),
			).toHaveLength(120);
			await createGrowthSnapshot(db, first);
			await createGrowthSnapshot(db, {
				...first,
				metrics: { ...first.metrics, facts: 2 },
			});
			expect(await listGrowthSnapshots(db, first.tediId)).toMatchObject({
				total: 1,
				data: [{ metrics: { facts: 2 } }],
			});
		});

		it("keeps new reconciliation findings open while resolving old ones in one batch", async () => {
			const finding = {
				siteId: "reconcile-site",
				slug: "example",
				type: "cms" as const,
				code: "old",
				severity: "error" as const,
				detail: "Example",
			};
			const input = {
				organizationId: "org",
				source: "scheduled" as const,
				startedAt: "2026-11-25T00:00:00Z",
				completedAt: "2026-11-25T00:00:01Z",
				sitesChecked: 1,
			};
			await recordSiteReconciliation(db, {
				...input,
				runId: "reconcile-first",
				findings: [finding],
			});
			const batch = vi.spyOn(db, "batch");
			try {
				await recordSiteReconciliation(db, {
					...input,
					runId: "reconcile-next",
					completedAt: "2026-11-25T01:00:01Z",
					findings: [{ ...finding, code: "new" }],
				});
				expect(batch).toHaveBeenCalledTimes(1);
			} finally {
				batch.mockRestore();
			}
			expect(await getLatestSiteReconciliation(db, "org")).toMatchObject({
				run: { id: "reconcile-next", issueCount: 1 },
				findings: [{ code: "new", resolvedAt: null }],
			});
			expect(await getLatestSiteReconciliation(db, "other")).toBeNull();
			expect(
				(await listSiteReconciliationOrganizations(db)).map((row) => row.id),
			).toContain("org");
			await expect(
				recordSiteReconciliation(db, {
					...input,
					runId: "reconcile-next",
					findings: [],
				}),
			).rejects.toThrow();
			expect(await getLatestSiteReconciliation(db, "org")).toMatchObject({
				findings: [{ code: "new", resolvedAt: null }],
			});
		});

		it("retains active and referenced CMS generations", async () => {
			await db.insert(coreTable(db, tenantBundles)).values(
				[1, 2, 3].map((version) => ({
					id: `cms-bundle-${version}`,
					slug: "bundle-example",
					version,
					r2Prefix: `example/v${version}`,
					mainModule: "entry.mjs",
					etag: `etag-${version}`,
					modulesJson: ["entry.mjs"],
					isActive: version === 3,
				})),
			);
			expect(await getActiveTenantBundle(db, "bundle-example")).toMatchObject({
				version: 3,
				modulesJson: ["entry.mjs"],
			});
			expect(
				await listPrunableTenantBundles(db, "bundle-example", 0, {
					compressedVersions: [1, 2],
					referencedVersions: [2],
				}),
			).toMatchObject([{ version: 1 }]);
			expect(await deleteTenantBundleRow(db, "bundle-example", 3)).toBe(false);
			expect(await deleteTenantBundleRow(db, "absent", 1)).toBe(false);
			expect(await deleteTenantBundleRow(db, "bundle-example", 1)).toBe(true);
			expect((await getActiveTenantBundle(db, "bundle-example"))?.version).toBe(
				3,
			);
		});

		it("stores structured version/template reports only on the owning configured project", async () => {
			const table = coreTable(db, projects);
			await db.insert(table).values([
				{
					id: "cms-report-project",
					orgId: "org",
					key: "CMSREPORT",
					name: "CMS",
					createdAt: "2026-11-26",
					metadata: {
						siteVersionCheck: { enabled: true },
						cmsTemplateUpstreamCheck: { enabled: true },
						keep: [1, true],
					},
				},
				{
					id: "cms-other-project",
					orgId: "other",
					key: "CMSREPORT",
					name: "CMS",
					createdAt: "2026-11-26",
					metadata: {
						siteVersionCheck: { enabled: true },
						cmsTemplateUpstreamCheck: { enabled: true },
					},
				},
			]);
			expect(
				(await listSiteVersionProjects(db, "org")).map((row) => row.id),
			).toEqual(["cms-report-project"]);
			expect(
				(await listCmsTemplateUpstreamProjects(db, "org")).map((row) => row.id),
			).toEqual(["cms-report-project"]);
			const version = {
				checkedAt: "2026-11-26",
				productRevision: "a".repeat(40),
				sites: [],
				alerts: [],
			};
			const template = {
				checkedAt: "2026-11-26",
				upstreamRevision: "b".repeat(40),
				projects: [],
			};
			await saveSiteVersionReport(db, "cms-report-project", "other", version);
			await saveCmsTemplateUpstreamReport(
				db,
				"cms-report-project",
				"other",
				template,
			);
			expect(
				(
					await db
						.select()
						.from(table)
						.where(eq(table.id, "cms-report-project"))
				)[0]?.metadata,
			).not.toHaveProperty("siteVersionReport");
			await saveSiteVersionReport(db, "cms-report-project", "org", version);
			await saveCmsTemplateUpstreamReport(
				db,
				"cms-report-project",
				"org",
				template,
			);
			expect(
				(
					await db
						.select()
						.from(table)
						.where(eq(table.id, "cms-report-project"))
				)[0]?.metadata,
			).toMatchObject({
				keep: [1, true],
				siteVersionReport: version,
				cmsTemplateUpstreamReport: template,
			});
			expect(
				await findSiteUpgradeWork(db, "org", "cms-report-project", "Absent"),
			).toBeNull();
			expect(
				await findOpenCmsTemplateUpstreamWork(
					db,
					"org",
					"cms-report-project",
					"Absent",
				),
			).toBeNull();
		});

		it("applies app templates in one atomic batch and persists structured job results", async () => {
			const template = await createTemplate(db, {
				slug: "PARITY-TEMPLATE",
				name: "Parity",
				vertical: "ecommerce",
				isActive: true,
				adapters: [
					{
						name: "example",
						adapterType: "custom",
						config: { baseUrl: "https://example.test" },
					},
				],
				tools: [
					{
						toolId: "read_items",
						title: "Read",
						toolTypeId: "rpc",
						writeCapability: "read",
						widgetKey: "render",
						config: { endpoint: "items/list" },
					},
				],
			});
			const batch = vi.spyOn(db, "batch");
			let result: Awaited<ReturnType<typeof applyTemplate>>;
			try {
				result = await applyTemplate(db, template.id, {
					organizationId: "org",
					name: "Template app",
					slug: "template-app",
					primaryDomain: "template.example.test",
				});
				expect(batch).toHaveBeenCalledTimes(1);
			} finally {
				batch.mockRestore();
			}
			expect(result.adapters).toMatchObject([
				{ config: { baseUrl: "https://example.test" } },
			]);
			expect(result.tools).toMatchObject([
				{ toolId: "read_items", writeCapability: "read" },
			]);
			await expect(
				applyTemplate(db, template.id, {
					organizationId: "org",
					name: "Duplicate",
					slug: "template-app",
					primaryDomain: "duplicate.example.test",
				}),
			).rejects.toThrow();
			const job = await createJob(db, {
				appId: result.app.id,
				type: "scrape",
				payload: { nested: [true, null] },
			});
			expect(job.payload).toEqual({ nested: [true, null] });
			expect(await updateJobStatus(db, job.id, "running")).toMatchObject({
				startedAt: expect.any(String),
			});
			expect(await updateJobProgress(db, job.id, { count: 3 })).toMatchObject({
				progress: { count: 3 },
			});
			expect(
				await updateJobStatus(db, job.id, "completed", {
					result: { values: [1, 2] },
				}),
			).toMatchObject({
				result: { values: [1, 2] },
				completedAt: expect.any(String),
			});
			expect(
				await countJobsByApp(db, result.app.id, { status: "completed" }),
			).toBe(1);
			expect(await getJobsByApp(db, "foreign-item-app")).toEqual([]);
			expect(await cleanupOldJobs(db, 7)).toBe(0);
			expect(
				await updateTemplate(db, template.id, { name: "Renamed" }),
			).toMatchObject({ name: "Renamed" });
			await deleteTemplate(db, template.id);
			expect(
				(await getTemplates(db)).some((row) => row.id === template.id),
			).toBe(false);
		});

		it("paginates plugin installs and events with isolated JSON values", async () => {
			await db.insert(coreTable(db, tediPlugins)).values({
				id: "parity-plugin",
				slug: "parity-plugin",
				name: "ÄLPHA plugin",
				type: "tool",
				version: "1.0",
				manifest: { nested: [true] },
			});
			expect(await listPlugins(db, { query: "Älpha" })).toMatchObject({
				total: 1,
				data: [{ manifest: { nested: [true] } }],
			});
			expect(await listPlugins(db, { query: "älpha" })).toMatchObject({
				total: 0,
				data: [],
			});
			await createPluginInstall(db, {
				id: "parity-install",
				orgId: "org",
				pluginId: "parity-plugin",
				config: { enabled: true },
			});
			expect(
				await getPluginInstall(db, "parity-install", "other"),
			).toBeUndefined();
			expect(
				await updatePluginInstall(db, "parity-install", {
					config: { nested: [null, true] },
				}),
			).toMatchObject({ config: { nested: [null, true] } });
			await createPluginEvent(db, {
				id: "parity-event",
				orgId: "org",
				pluginId: "parity-plugin",
				eventType: "read",
				payload: { input: [1] },
			});
			expect(
				await listPluginEvents(db, { orgId: "org", pluginId: "parity-plugin" }),
			).toMatchObject({ total: 1, data: [{ payload: { input: [1] } }] });
			expect(await listPluginEvents(db, { orgId: "other" })).toEqual({
				total: 0,
				data: [],
			});
		});

		it("deletes push subscription sets once while keeping other tenants and active visibility", async () => {
			const scope = { organizationId: "org", userId: "push-user" };
			await savePushConfig(db, scope, "subscription:first", {
				endpoint: "https://example.test/push",
			});
			await savePushConfig(
				db,
				{ ...scope, organizationId: "other" },
				"subscription:first",
				{ endpoint: "https://other.example.test/push" },
			);
			const keys = Array.from({ length: 120 }, (_, i) => `subscription:${i}`);
			await db.batch(
				batchNonEmpty(
					keys.map((key, i) =>
						db.insert(coreTable(db, userConfigs)).values({
							id: `push-${i}`,
							userId: scope.userId,
							namespace: "os.push:org",
							key,
							value: {},
						}),
					),
				),
			);
			expect(await listPushConfigs(db, scope, "SUBSCRIPTION:")).toHaveLength(
				100,
			);
			const deletion = vi.spyOn(db, "delete");
			try {
				await deletePushConfigs(db, scope, [...keys, "subscription:first"]);
				expect(deletion).toHaveBeenCalledTimes(1);
			} finally {
				deletion.mockRestore();
			}
			expect(await listPushConfigs(db, scope, "subscription:")).toEqual([]);
			expect(
				await listPushConfigs(
					db,
					{ ...scope, organizationId: "other" },
					"subscription:",
				),
			).toHaveLength(1);
			await savePushConfig(db, scope, "visible:one", {
				conversationId: "visible-chat",
			});
			expect(
				await hasVisiblePushConversation(db, scope, "visible-chat", Date.now()),
			).toBe(true);
		});

		it("keeps entity images and model fallback scoped to the owning tenant", async () => {
			const app = coreTable(db, apps);
			await db.insert(app).values({
				id: "image-app",
				organizationId: "org",
				name: "Images",
				slug: "images",
			});
			const input = {
				entityType: "app" as const,
				entityId: "image-app",
				organizationId: "org",
			};
			await updateEntityImageUrl(db, {
				...input,
				organizationId: "other",
				url: "https://other.example.test/logo",
			});
			expect(await getEntityImageUrl(db, input)).toBeNull();
			await updateEntityImageUrl(db, {
				...input,
				url: "https://example.test/logo",
			});
			expect(await getEntityImageUrl(db, input)).toBe(
				"https://example.test/logo",
			);
			expect(
				await listLegacyEntityImagesForPlatform(db, "app", 100),
			).toContainEqual({ id: "image-app", url: "https://example.test/logo" });
			const policy = { version: 1 as const, maxTransitions: 0, ladder: {} };
			await db
				.update(coreTable(db, organizations))
				.set({ metadata: { modelFallback: policy } })
				.where(eq(coreTable(db, organizations).id, "org"));
			expect(await getOrganizationModelFallback(db, "org")).toEqual(policy);
			expect(await getOrganizationModelFallback(db, "other")).toBeNull();
		});

		const site = (id: string) =>
			registerCmsSite(db, {
				id,
				organizationId: "org",
				slug: id,
				name: id,
				canonicalUrl: `https://${id}.example.test`,
			});

		it("keeps quota, nested config and tenant moves faithful in one write batch", async () => {
			const input = {
				id: "quota",
				organizationId: "org",
				slug: "quota",
				name: "Quota",
				canonicalUrl: "https://quota.example.test",
				config: { seo: { title: "Keep" } },
			};
			expect(await registerCmsSiteWithinQuota(db, input, 1)).toMatchObject({
				id: "quota",
			});
			expect(
				await registerCmsSiteWithinQuota(
					db,
					{ ...input, id: "overflow", slug: "overflow" },
					1,
				),
			).toBeNull();
			await rotateCmsSitePageCacheRevision(db, {
				siteId: "quota",
				slug: "quota",
				restoreEpoch: 0,
				revision: "shared",
			});
			await rotateCmsSitePageCacheRevision(db, {
				siteId: "quota",
				slug: "quota",
				restoreEpoch: 0,
				revision: "bucket",
				entryBucket: 7,
			});
			await rotateCmsSitePageCacheRevision(db, {
				siteId: "quota",
				slug: "quota",
				restoreEpoch: 9,
				revision: "wrong",
			});
			expect((await getCmsSiteById(db, "quota"))?.config).toEqual({
				seo: { title: "Keep" },
				pageCacheRevision: "bucket",
				pageCacheSharedRevision: "shared",
				pageCacheEntryRevisions: { "7": "bucket" },
			});
			const batch = vi.spyOn(db, "batch");
			try {
				expect(
					await moveCmsSiteToOrganization(db, {
						id: "quota",
						fromOrganizationId: "other",
						toOrganizationId: "org",
					}),
				).toBe(false);
				batch.mockClear();
				expect(
					await moveCmsSiteToOrganization(db, {
						id: "quota",
						fromOrganizationId: "org",
						toOrganizationId: "other",
					}),
				).toBe(true);
				expect(batch).toHaveBeenCalledTimes(1);
				expect(batch.mock.calls[0]![0]).toHaveLength(store === "d1" ? 2 : 3);
			} finally {
				batch.mockRestore();
			}
			expect((await getCmsSiteById(db, "quota"))?.organizationId).toBe("other");
		});

		it("preserves restore epochs, permit drains and cleanup exclusion", async () => {
			await site("restore");
			const permit = {
				siteId: "restore",
				slug: "restore",
				restoreEpoch: 0,
				permitId: "lease:v1:restore",
				kind: "outer" as const,
			};
			const fence = {
				siteId: "restore",
				slug: "restore",
				generation: "generation",
				captureId: "capture",
			};
			expect(await enterCmsRestorePermit(db, permit)).toBe(true);
			const batch = vi.spyOn(db, "batch");
			try {
				expect(await closeCmsRestoreFence(db, fence)).toBe(true);
				expect(batch).toHaveBeenCalledTimes(1);
			} finally {
				batch.mockRestore();
			}
			expect(await getCmsRestoreEpoch(db, permit)).toBe(1);
			expect(
				await enterCmsRestorePermit(db, { ...permit, permitId: "late" }),
			).toBe(false);
			expect(await releaseCmsRestoreFence(db, fence)).toBe(false);
			expect(
				await pauseCmsSiteUnlessRestoring(db, {
					id: "restore",
					organizationId: "org",
					authoringAppId: null,
				}),
			).toBe(false);
			await expect(
				reserveCmsDeprovisionOperation(db, {
					siteId: "restore",
					slug: "restore",
					organizationId: "org",
					authoringAppId: null,
				}),
			).rejects.toThrow("restore_fenced");
			expect(await leaveCmsRestorePermit(db, permit)).toBe(true);
			expect(
				await releaseCmsRestoreFence(db, { ...fence, captureId: "wrong" }),
			).toBe(false);
			expect(await releaseCmsRestoreFence(db, fence)).toBe(true);
			expect(
				await reserveCmsDeprovisionOperation(db, {
					siteId: "restore",
					slug: "restore",
					organizationId: "org",
					authoringAppId: null,
				}),
			).toMatchObject({ id: "restore", status: "queued" });
			expect(
				await enterCmsRestorePermit(db, { ...permit, restoreEpoch: 1 }),
			).toBe(false);
			const completion = vi.spyOn(db, "batch");
			try {
				expect(
					await completeCmsDeprovisionOperation(db, {
						siteId: "restore",
						organizationId: "org",
						deleted: ["data"],
					}),
				).toMatchObject({ status: "succeeded", deleted: ["data"], errors: [] });
				expect(completion).toHaveBeenCalledTimes(1);
			} finally {
				completion.mockRestore();
			}
			expect(await getCmsSiteById(db, "restore")).toBeNull();
		});

		it("keeps capture ownership and lease-expiry boundaries", async () => {
			await site("capture");
			const pause = {
				siteId: "capture",
				slug: "capture",
				captureId: "capture",
			};
			const permit = {
				siteId: "capture",
				slug: "capture",
				restoreEpoch: 0,
				permitId: "lease:v1:capture",
				kind: "scheduled" as const,
			};
			expect(await claimCmsCaptureCronPause(db, pause)).toBe(true);
			expect(await enterCmsRestorePermit(db, permit)).toBe(false);
			expect(await confirmCmsCaptureCronPause(db, pause)).toBe(true);
			expect(await assertCmsCaptureCronPause(db, pause)).toBe(true);
			expect(
				await releaseCmsCaptureCronPause(db, { ...pause, captureId: "other" }),
			).toBe(false);
			expect(await releaseCmsCaptureCronPause(db, pause)).toBe(true);
			expect(await enterCmsRestorePermit(db, permit)).toBe(true);
			expect(await renewCmsRestorePermitLease(db, permit)).toBe(true);
			const permits = coreTable(db, cmsRestorePermits);
			await db
				.update(permits)
				.set({ enteredAt: "2000-01-01 00:00:00" })
				.where(eq(permits.id, permit.permitId));
			expect(await renewCmsRestorePermitLease(db, permit)).toBe(false);
			expect(
				await deleteExpiredCmsRestorePermitLeases(db, {
					siteId: "capture",
					limit: 1,
				}),
			).toEqual([
				{ id: permit.permitId, siteId: "capture", kind: "scheduled" },
			]);
		});

		it("binds provider routes and www aliases to the current tenant and apex", async () => {
			await site("domain");
			const primary = {
				id: "primary",
				siteId: "domain",
				organizationId: "org",
			};
			const reserve = {
				...primary,
				hostname: "apex.example.test",
				verificationToken: "proof",
				expiresAt: "2099-01-01T00:00:00.000Z",
			};
			expect(
				await reserveCmsDomainClaim(db, {
					...reserve,
					organizationId: "other",
				}),
			).toBeNull();
			expect(await reserveCmsDomainClaim(db, reserve)).toMatchObject({
				status: "pending",
			});
			const started = await beginCmsDomainProvisioning(db, primary);
			expect(started).toMatchObject({ status: "provisioning" });
			expect(
				await finishCmsDomainProvisioning(db, {
					...primary,
					providerHostnameId: "provider-primary",
					provisioningStartedAt: started!.updatedAt,
				}),
			).toMatchObject({ status: "pending" });
			expect(await activateCmsDomainClaim(db, primary)).toMatchObject({
				status: "active",
			});
			const alias = {
				...primary,
				id: "alias",
				hostname: "www.apex.example.test",
				kind: "www_alias" as const,
				verificationToken: "proof",
				expiresAt: reserve.expiresAt,
			};
			expect(await reserveCmsDomainClaim(db, alias)).toMatchObject({
				id: "alias",
			});
			const startedAlias = await beginCmsDomainProvisioning(db, alias);
			await finishCmsDomainProvisioning(db, {
				...alias,
				providerHostnameId: "provider-alias",
				provisioningStartedAt: startedAlias!.updatedAt,
			});
			expect(await activateCmsWwwAliasClaim(db, alias)).toMatchObject({
				status: "active",
			});
			expect((await getCmsSiteByActiveWwwAlias(db, alias.hostname))?.id).toBe(
				"domain",
			);
			expect(await beginRemovingCmsDomainClaim(db, primary)).toMatchObject({
				status: "removing",
			});
			expect(await getCmsSiteByActiveWwwAlias(db, alias.hostname)).toBeNull();
			// The migrated constraints must reject both kinds of duplicate claim.
			const claims = coreTable(db, cmsDomainClaims);
			const row = {
				organizationId: "org",
				siteId: "domain",
				hostname: "pending.example.test",
				verificationToken: "proof",
				expiresAt: reserve.expiresAt,
			};
			await db.insert(claims).values({ ...row, id: "pending" });
			await expect(
				db.insert(claims).values({
					...row,
					id: "duplicate",
					hostname: "duplicate.example.test",
				}),
			).rejects.toThrow();
			await db.insert(claims).values({
				...row,
				id: "organization",
				siteId: null,
				kind: "organization",
				hostname: "org.example.test",
			});
			await expect(
				db.insert(claims).values({
					...row,
					id: "organization-duplicate",
					siteId: null,
					kind: "organization",
					hostname: "other-org.example.test",
				}),
			).rejects.toThrow();
		});
		it("binds schema inference candidates as JSON documents on the actual driver", async () => {
			await db.insert(coreTable(db, appCatalog)).values({
				id: "catalog",
				name: "Catalog",
				connectorType: "MCP",
				lastSyncedAt: "2026-11-25T00:00:00.000Z",
			});
			await db.insert(coreTable(db, apps)).values([
				{
					id: "installed-one",
					organizationId: "org",
					slug: "installed-one",
					name: "One",
					catalogAppId: "catalog",
				},
				{
					id: "installed-two",
					organizationId: "org",
					slug: "installed-two",
					name: "Two",
					catalogAppId: "catalog",
				},
			]);
			const tools = coreTable(db, appTools);
			for (const id of ["installed-one", "installed-two"])
				await db.insert(tools).values({
					id,
					appId: id,
					toolId: "list_records",
					title: "List records",
					toolTypeId: "mcp",
					config: {
						transport: "mcp",
						mcpServerId: "catalog",
						mcpToolName: "list_records",
					},
				});
			expect(
				await inferCatalogToolOutputSchemas(
					db,
					"catalog",
					"list_records",
					() => ({ count: 1 }),
				),
			).toBe(2);
			expect(
				(await db.select().from(tools).where(eq(tools.id, "installed-one")))[0]
					?.outputSchema,
			).toEqual({
				type: "object",
				required: ["count"],
				properties: { count: { type: "number" } },
				"x-tedix-provenance": "inferred",
			});
			expect(
				await inferCatalogToolOutputSchemas(
					db,
					"catalog",
					"list_records",
					() => ({ count: 2, next: true }),
				),
			).toBe(2);
			expect(
				(await db.select().from(tools).where(eq(tools.id, "installed-one")))[0]
					?.outputSchema,
			).toMatchObject({
				properties: { count: { type: "number" }, next: { type: "boolean" } },
			});
		});

		it("resolves app references and inherited logos with one lookup per candidate set", async () => {
			await db.insert(coreTable(db, appCatalog)).values({
				id: "lookup-catalog",
				name: "Lookup",
				connectorType: "MCP",
				lastSyncedAt: "now",
				logoUrl: "https://example.test/logo.png",
			});
			await db.insert(coreTable(db, apps)).values([
				{
					id: "lookup-base",
					organizationId: "org",
					slug: "lookup",
					name: "Lookup",
					catalogAppId: "lookup-catalog",
					metadata: {
						mcpConfig: { autoSync: true, openApiSync: { enabled: true } },
					},
				},
				{
					id: "lookup-foreign",
					organizationId: "other",
					slug: "lookup",
					name: "Foreign",
				},
				{
					id: "lookup-proxy",
					organizationId: "org",
					slug: "lookup-proxy",
					name: "Proxy",
					sourceAppId: "lookup-base",
					catalogAppId: "lookup-catalog",
				},
			]);
			expect((await getAppBySlugForOrg(db, "LOOKUP", "other"))?.id).toBe(
				"lookup-foreign",
			);
			expect(await listApiSyncApps(db, { source: "openapi" })).toEqual([
				{ id: "lookup-base", slug: "lookup" },
			]);
			expect(await listApiSyncApps(db, { source: "google-discovery" })).toEqual(
				[],
			);
			expect(Number(await countAutoSyncBaseApps(db))).toBe(1);
			const table = coreTable(db, apps);
			for (const [flag, enabled] of [
				[1, true],
				["1", false],
				[false, false],
			] as const) {
				const metadata = JSON.stringify({
					mcpConfig: { openApiSync: { enabled: flag } },
				});
				await db
					.update(table)
					.set({
						metadata:
							store === "d1" ? sql`${metadata}` : sql`${metadata}::text::jsonb`,
					})
					.where(eq(table.id, "lookup-base"));
				expect((await listApiSyncApps(db, { source: "openapi" })).length).toBe(
					enabled ? 1 : 0,
				);
			}

			const missing = Array.from(
				{ length: 300 },
				(_, index) => `lookup-missing-${index}`,
			);
			const select = vi.spyOn(db, "select");
			try {
				for (const lookup of [
					listAppReferenceMetadataByIds,
					listPreviewSourceAppsByIds,
				]) {
					select.mockClear();
					expect(
						(await lookup(db, [...missing, "lookup-base"])).map(
							(row) => row.id,
						),
					).toEqual(["lookup-base"]);
					expect(select).toHaveBeenCalledTimes(1);
				}
				for (const lookup of [
					listAppReferenceMetadataBySlugs,
					listPreviewSourceAppsBySlugs,
				]) {
					select.mockClear();
					expect(
						(await lookup(db, [...missing, " LOOKUP "]))
							.map((row) => row.id)
							.sort(),
					).toEqual(["lookup-base", "lookup-foreign"]);
					expect(select).toHaveBeenCalledTimes(1);
				}
				select.mockClear();
				expect(
					(
						await listBaseAppsForCatalogApps(db, [...missing, "lookup-catalog"])
					).map((row) => row.id),
				).toEqual(["lookup-base"]);
				expect(select).toHaveBeenCalledTimes(1);
				select.mockClear();
				const logos = await getInheritedAppLogos(db, [
					...missing.map((id) => ({
						id,
						logoUrl: null,
						sourceAppId: id,
						catalogAppId: id,
					})),
					{
						id: "lookup-proxy",
						logoUrl: null,
						sourceAppId: "lookup-base",
						catalogAppId: null,
					},
				]);
				expect(Object.fromEntries(logos)).toEqual({
					"lookup-proxy": "https://example.test/logo.png",
				});
				expect(select).toHaveBeenCalledTimes(2);
			} finally {
				select.mockRestore();
			}
		});

		it("advances app and tool generations on authority changes and deletion", async () => {
			const table = coreTable(db, apps);
			const tools = coreTable(db, appTools);
			const generations = coreTable(db, tenantToolPolicyResourceGenerations);
			const generation = async (resourceId: string) =>
				(
					await db
						.select()
						.from(generations)
						.where(eq(generations.resourceId, resourceId))
				)[0]?.generation;
			await db.insert(table).values({
				id: "generation-app",
				organizationId: "org",
				slug: "generation-app",
				name: "Initial",
			});
			expect(await generation("generation-app")).toBe(1);
			await db
				.update(table)
				.set({ name: "Renamed" })
				.where(eq(table.id, "generation-app"));
			expect(await generation("generation-app")).toBe(1);
			await db
				.update(table)
				.set({ metadata: { mcpConfig: { aggregateApps: [] } } })
				.where(eq(table.id, "generation-app"));
			expect(await generation("generation-app")).toBe(2);
			await db.insert(tools).values({
				id: "generation-tool",
				appId: "generation-app",
				toolId: "read",
				toolTypeId: "rpc",
				title: "Read",
			});
			expect(await generation("generation-tool")).toBe(1);
			await db
				.update(tools)
				.set({ enabled: false })
				.where(eq(tools.id, "generation-tool"));
			expect(await generation("generation-tool")).toBe(2);
			await db.delete(tools).where(eq(tools.id, "generation-tool"));
			expect(await generation("generation-tool")).toBe(3);
			await deleteApp(db, "generation-app");
			expect(await generation("generation-app")).toBe(3);
		});

		it("preserves gateway restrictions and tenant boundaries through toggles and deletion", async () => {
			const table = coreTable(db, apps);
			const initial = {
				custom: { keep: true },
				mcpConfig: {
					aggregateApps: [
						{ slug: "app-member", prefix: "keep", toolIds: ["read"] },
					],
					inactiveAggregateApps: [],
					toolScopes: { read: ["apps:read"] },
				},
			};
			await db.insert(table).values([
				{
					id: "app-member",
					organizationId: "org",
					slug: "app-member",
					name: "Member",
				},
				{
					id: "app-gateway",
					organizationId: "org",
					slug: "app-gateway",
					name: "Gateway",
					metadata: initial,
				},
				{
					id: "foreign-gateway",
					organizationId: "other",
					slug: "foreign-gateway",
					name: "Foreign",
					metadata: initial,
				},
			]);
			const member = { appId: "app-member", slug: "app-member" };
			await setAppGatewayMembership(db, "org", "app-gateway", member, true);
			await setAppGatewayMembership(db, "org", "app-gateway", member, false);
			const renamed = { ...member, slug: "renamed" };
			await setAppGatewayMembership(db, "org", "app-gateway", renamed, true);
			expect((await getAppById(db, "app-gateway"))?.metadata).toEqual({
				...initial,
				mcpConfig: {
					...initial.mcpConfig,
					aggregateApps: [{ ...renamed, prefix: "keep", toolIds: ["read"] }],
				},
			});
			expect(
				await setAppGatewayMembership(
					db,
					"other",
					"app-gateway",
					member,
					false,
				),
			).toEqual([]);
			await Promise.all([
				setAppGatewayMembership(
					db,
					"org",
					"app-gateway",
					{ appId: "one", slug: "one" },
					true,
				),
				setAppGatewayMembership(
					db,
					"org",
					"app-gateway",
					{ appId: "two", slug: "two" },
					true,
				),
			]);
			expect(
				(
					(await getAppById(db, "app-gateway"))?.metadata?.mcpConfig
						?.aggregateApps as Array<{ appId: string }>
				)
					.map((entry) => entry.appId)
					.sort(),
			).toEqual(["app-member", "one", "two"]);
			const batch = vi.spyOn(db, "batch");
			try {
				expect(await deleteApp(db, "app-member")).toBe(true);
				expect(batch).toHaveBeenCalledTimes(1);
			} finally {
				batch.mockRestore();
			}
			expect(
				(
					(await getAppById(db, "app-gateway"))?.metadata?.mcpConfig
						?.aggregateApps as Array<{ appId: string }>
				)
					.map((entry) => entry.appId)
					.sort(),
			).toEqual(["one", "two"]);
			expect((await getAppById(db, "foreign-gateway"))?.metadata).toEqual(
				initial,
			);
		});

		it("hydrates ordered tools with large candidate sets and faithful compact contract schemas", async () => {
			await db.insert(coreTable(db, apps)).values({
				id: "record-app",
				organizationId: "org",
				slug: "record-app",
				name: "Records",
			});
			const schema = {
				type: "object" as const,
				description: 'a, b "quoted" \u005c path',
				properties: { id: { type: "string" as const } },
			};
			const tools = coreTable(db, appTools);
			await db.insert(tools).values([
				{
					id: "record-null",
					appId: "record-app",
					toolId: "read_null",
					title: "Null",
					toolTypeId: "rpc",
					sortOrder: null,
					createdAt: null,
					inputSchema: schema,
					config: { endpoint: "records/null" },
				},
				{
					id: "record-one",
					appId: "record-app",
					toolId: "read_one",
					title: "One",
					toolTypeId: "rpc",
					sortOrder: 1,
					inputSchema: schema,
					config: { endpoint: "records/one" },
				},
				{
					id: "record-pending",
					appId: "record-app",
					toolId: "read_pending",
					title: "Pending",
					toolTypeId: "rpc",
					reviewState: "pending",
					config: { endpoint: "records/pending" },
				},
			]);
			const candidates = [
				...Array.from({ length: 300 }, (_, i) => `missing-${i}`),
				"read_null",
				"read_one",
			];
			const surface = await getAppBySlugWithTools(db, "record-app", {
				toolIds: candidates,
				endpointPrefixes: [...candidates, "Records"],
			});
			expect(surface?.tools.map((tool) => tool.id)).toEqual([
				"record-null",
				"record-one",
			]);
			const [contract, absent, definition] = await getAppsBySlugsWithTools(db, [
				{
					appId: "record-app",
					slug: "ignored",
					hostOrganizationId: "org",
					projection: "contract",
					toolIds: candidates,
				},
				{ slug: "absent-app" },
				{ slug: "record-app" },
			]);
			expect(absent).toBeNull();
			expect(
				contract?.tools.map((tool) => [
					tool.id,
					tool.inputSchema,
					tool.inputSchemaChars,
				]),
			).toEqual([
				["record-null", { type: "object" }, JSON.stringify(schema).length],
				["record-one", { type: "object" }, JSON.stringify(schema).length],
			]);
			expect(definition?.tools[0]?.inputSchema).toEqual(schema);
			const select = vi.spyOn(db, "select");
			try {
				expect(
					await getAggregateAppLinkTargets(db, {
						ids: [...candidates, "record-app"],
						slugs: [],
					}),
				).toEqual([
					{ id: "record-app", slug: "record-app", organizationId: "org" },
				]);
				expect(select).toHaveBeenCalledTimes(1);
				select.mockClear();
				expect(
					await getAppsWithGatingByIds(
						db,
						[...candidates, "record-app", "foreign-gateway"],
						"org",
					),
				).toEqual([{ id: "record-app", gatingMetadata: null }]);
				expect(select).toHaveBeenCalledTimes(1);
			} finally {
				select.mockRestore();
			}
		});

		it.skipIf(store !== "native-postgres")(
			"serializes separate-connection version allocation and competing reference renames",
			async () => {
				const peer = createCoreStore({
					CORE_STORE: "postgres",
					CORE_HYPERDRIVE: { connectionString: nativeConnectionString },
				});
				try {
					const table = coreTable(db, apps);
					await db.insert(table).values([
						{
							id: "version-race",
							organizationId: "org",
							slug: "version-race",
							name: "Race",
						},
						{
							id: "rename-race-a",
							organizationId: "org",
							slug: "rename-race-a",
							name: "A",
						},
						{
							id: "rename-race-b",
							organizationId: "other",
							slug: "rename-race-b",
							name: "B",
						},
					]);
					const versions = await Promise.all([
						createAppConfigVersion(db, {
							appId: "version-race",
							config: { caller: "first" },
						}),
						createAppConfigVersion(peer.db, {
							appId: "version-race",
							config: { caller: "second" },
						}),
					]);
					expect(versions.map((row) => row.version).sort()).toEqual([1, 2]);
					const renames = await Promise.allSettled([
						applyAppReferenceWrites(db, [
							{
								kind: "app_slug",
								appId: "rename-race-a",
								before: "rename-race-a",
								after: "shared-rename",
							},
						]),
						applyAppReferenceWrites(peer.db, [
							{
								kind: "app_slug",
								appId: "rename-race-b",
								before: "rename-race-b",
								after: "shared-rename",
							},
						]),
					]);
					expect(
						renames.filter((row) => row.status === "fulfilled"),
					).toHaveLength(1);
					expect(
						await db
							.select({ id: table.id })
							.from(table)
							.where(eq(table.slug, "shared-rename")),
					).toHaveLength(1);
				} finally {
					await peer.close();
				}
			},
		);

		it.skipIf(store !== "native-postgres")(
			"serializes restore close against a separate connection's cleanup admission",
			async () => {
				const peer = createCoreStore({
					CORE_STORE: "postgres",
					CORE_HYPERDRIVE: { connectionString: nativeConnectionString },
				});
				try {
					for (let index = 0; index < 10; index++) {
						const id = `race-${index}`;
						await site(id);
						const [closed, reserved] = await Promise.allSettled([
							closeCmsRestoreFence(peer.db, {
								siteId: id,
								slug: id,
								generation: "generation",
								captureId: "capture",
							}),
							reserveCmsDeprovisionOperation(db, {
								siteId: id,
								slug: id,
								organizationId: "org",
								authoringAppId: null,
							}),
						]);
						expect(closed.status).toBe("fulfilled");
						if (closed.status !== "fulfilled") throw closed.reason;
						expect(closed.value).toBe(reserved.status === "rejected");
						if (reserved.status === "rejected")
							expect(reserved.reason.message).toContain("restore_fenced");
					}
				} finally {
					await peer.close();
				}
			},
		);
	});
}
