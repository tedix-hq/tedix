import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable, createCoreStore } from "../core-store/client";
import postgres from "postgres";
import { apps } from "../schema/apps";
import { appCatalog } from "../schema/catalog";
import { appTools } from "../schema/tools";
import { tenantToolPolicyResourceGenerations } from "../schema/tenant-tool-policy";
import {
	deleteApp,
	getAppById,
	getAppBySlugWithTools,
	getAppsBySlugsWithTools,
	setAppGatewayMembership,
} from "./app-records";
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
