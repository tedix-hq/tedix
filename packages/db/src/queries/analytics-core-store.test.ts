import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { createD1Facade } from "../test/d1-facade";
import { createPGliteFacade } from "../test/pglite-facade";
import { schemaDdl } from "../test/schema-ddl";
import { organizations } from "../schema/organizations";
import { apps } from "../schema/apps";
import { appCatalog } from "../schema/catalog";
import { appTools } from "../schema/tools";
import { organizationMembers } from "../schema/organization-members";
import { users } from "../schema/users";
import { tedis } from "../schema/tedis";
import { apiKeys } from "../schema/api-keys";
import { osWorkspaces } from "../schema/os-workspaces";
import { projects } from "../schema/projects";
import { items } from "../schema/items";
import {
	policyPacks,
	runtimeProfiles,
	workspaceTemplateSets,
} from "../schema/control-plane";
import { providerInstallations } from "../schema/provider-installations";
import { widgetEvents, type NewWidgetEvent } from "../schema/analytics";
import {
	getOrganizationIdForApp,
	getOrganizationIdsForApps,
	listEmbeddedAttentionReviews,
	listEmbeddedProviderActivity,
	trackEmbeddedAttentionOutcome,
	trackEmbeddedAttentionOutcomes,
	trackWidgetEvent,
	trackWidgetEvents,
} from "./analytics";
import {
	listAnalyticsAppsByIds,
	listAnalyticsAppsBySlugs,
	listAnalyticsOrganizationMembers,
	listAnalyticsTedis,
	listAnalyticsTools,
	listAnalyticsUsers,
} from "./analytics-hydration";

const at = "2026-09-01T12:00:00.000Z";
const candidates = Array.from(
	{ length: 300 },
	(_, index) => `missing-${index}`,
);

for (const store of ["d1", "postgres"] as const)
	describe(`analytics core store: ${store}`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = new DatabaseSync(":memory:");
				sqlite.exec(
					schemaDdl(
						organizations,
						appCatalog,
						apps,
						appTools,
						organizationMembers,
						users,
						runtimeProfiles,
						policyPacks,
						workspaceTemplateSets,
						tedis,
						apiKeys,
						projects,
						osWorkspaces,
						items,
						widgetEvents,
						providerInstallations,
					),
				);
				db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				// Use the entire generated migration, retaining checks, indexes and FKs.
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
			await db.insert(coreTable(db, apps)).values([
				{ id: "app", organizationId: "org", name: "App", slug: "app" },
				{
					id: "other-app",
					organizationId: "other",
					name: "Other",
					slug: "other-app",
					sourceAppId: "app",
				},
			]);
			await db.insert(coreTable(db, appTools)).values([
				{
					id: "tool",
					appId: "app",
					toolId: 'lookup"\\,{}',
					title: "Lookup",
					toolTypeId: "rpc",
					inputSchema: { type: "object", properties: {} },
				},
				{
					id: "other-tool",
					appId: "other-app",
					toolId: "private",
					title: "Private",
					toolTypeId: "rpc",
					inputSchema: { type: "object", properties: {} },
				},
			]);
			await db
				.insert(coreTable(db, users))
				.values({ id: "user", email: "global@example.test", name: "Global" });
			await db.insert(coreTable(db, organizationMembers)).values([
				{
					id: "member",
					organizationId: "org",
					descopeUserId: "user",
					email: "org@example.test",
				},
				{
					id: "other-member",
					organizationId: "other",
					descopeUserId: "user",
					email: "other@example.test",
				},
			]);
			await db.insert(coreTable(db, tedis)).values([
				{
					id: "tedi",
					organizationId: "org",
					name: "Tedi",
					slug: "tedi",
					descopeUserId: "tedi-user",
				},
				{
					id: "other-tedi",
					organizationId: "other",
					name: "Other",
					slug: "other",
					descopeUserId: "other-user",
				},
			]);
			await db.insert(coreTable(db, apiKeys)).values([
				{
					id: "key",
					organizationId: "org",
					name: "Test",
					keyHash: "fictional-hash",
					keyPreview: "test",
				},
				{
					id: "other-key",
					organizationId: "other",
					name: "Other",
					keyHash: "fictional-other-hash",
					keyPreview: "other",
				},
			]);
			await db.insert(coreTable(db, osWorkspaces)).values([
				{
					id: "workspace",
					organizationId: "org",
					name: "Test",
					createdByKind: "service",
					createdById: "test",
					createdAt: at,
					updatedAt: at,
				},
				{
					id: "other-workspace",
					organizationId: "other",
					name: "Other",
					createdByKind: "service",
					createdById: "test",
					createdAt: at,
					updatedAt: at,
				},
			]);
			await db.insert(coreTable(db, providerInstallations)).values([
				{
					id: "installation",
					providerOrganizationId: "org",
					providerAppId: "app",
					providerApiKeyId: "key",
					externalTenantId: "tenant",
					customerOrganizationId: "org",
					primaryWorkspaceId: "workspace",
					primaryTediId: "tedi",
					allowedOrigin: "https://example.test",
					hostTenantArgument: "tenantId",
					hostTenantNamespace: "test",
					provisionedBy: "test",
					createdAt: at,
					updatedAt: at,
				},
				{
					id: "other-installation",
					providerOrganizationId: "other",
					providerAppId: "other-app",
					providerApiKeyId: "other-key",
					externalTenantId: "other-tenant",
					customerOrganizationId: "other",
					primaryWorkspaceId: "other-workspace",
					primaryTediId: "other-tedi",
					allowedOrigin: "https://other.example.test",
					hostTenantArgument: "tenantId",
					hostTenantNamespace: "test",
					provisionedBy: "test",
					createdAt: at,
					updatedAt: at,
				},
			]);
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("hydrates large intersecting identity sets without leaking scoped members or duplicating tedis", async () => {
			expect(await getOrganizationIdForApp(db, "app")).toBe("org");
			expect(await getOrganizationIdForApp(db, "absent")).toBeNull();
			expect(
				await getOrganizationIdsForApps(db, [...candidates, "app", "app"]),
			).toEqual(new Map([["app", "org"]]));
			expect(
				await listAnalyticsAppsByIds(db, [...candidates, "app", "app"]),
			).toEqual([{ id: "app", name: "App", slug: "app" }]);
			expect(
				await listAnalyticsAppsBySlugs(db, [...candidates, "other-app"]),
			).toMatchObject([{ id: "other-app", sourceAppId: "app" }]);
			expect(
				await listAnalyticsTools(db, {
					appIds: [...candidates, "app"],
					toolIds: [...candidates, 'lookup"\\,{}', "private"],
				}),
			).toEqual([{ appId: "app", toolId: 'lookup"\\,{}', title: "Lookup" }]);
			expect(
				await listAnalyticsOrganizationMembers(db, {
					organizationId: "org",
					userIds: [...candidates, "user"],
				}),
			).toMatchObject([{ email: "org@example.test" }]);
			expect(
				await listAnalyticsUsers(db, [...candidates, "user"]),
			).toMatchObject([{ id: "user", name: "Global" }]);
			expect(
				await listAnalyticsTedis(db, {
					organizationId: "org",
					principalIds: [...candidates, "tedi-user", "other-user"],
					tediIds: ["tedi", "other-tedi"],
					slugs: ["tedi", "other"],
				}),
			).toMatchObject([{ id: "tedi", slug: "tedi" }]);
			expect(
				await listAnalyticsTools(db, { appIds: [], toolIds: ["private"] }),
			).toEqual([]);
			expect(
				await listAnalyticsTedis(db, {
					principalIds: [],
					tediIds: [],
					slugs: [],
				}),
			).toEqual([]);
		});

		it("keeps bulk writes in one atomic batch, rolls back a later conflict, and supports replay", async () => {
			const events: NewWidgetEvent[] = Array.from(
				{ length: 25 },
				(_, index) => ({
					id: `bulk-${index}`,
					organizationId: "org",
					appId: "app",
					sessionId: "session",
					eventType: "attention_impression",
					itemId: null,
					itemPosition: index,
					widgetKey: "deck",
					displayMode: "inline",
					metadata: { index },
					createdAt: at,
				}),
			);
			const batch = vi.spyOn(db, "batch");
			try {
				await trackWidgetEvents(db, events);
				expect(batch).toHaveBeenCalledTimes(1);
				batch.mockClear();
				await expect(
					trackWidgetEvents(db, [
						...events.map((event) => ({
							...event,
							id: `rollback-${event.id}`,
						})),
						events[0]!,
					]),
				).rejects.toThrow();
				expect(batch).toHaveBeenCalledTimes(1);
				const table = coreTable(db, widgetEvents);
				expect(
					await db
						.select({ id: table.id })
						.from(table)
						.where(eq(table.id, "rollback-bulk-0")),
				).toEqual([]);
				batch.mockClear();
				await trackEmbeddedAttentionOutcomes(db, events);
				expect(batch).toHaveBeenCalledTimes(1);
				const [count] = await db
					.select({ count: sql<number>`count(*)`.mapWith(Number) })
					.from(table);
				expect(count?.count).toBe(25);
				batch.mockClear();
				await trackWidgetEvents(db, []);
				await trackEmbeddedAttentionOutcomes(db, []);
				expect(batch).not.toHaveBeenCalled();
			} finally {
				batch.mockRestore();
			}
		});

		it("filters embedded activity by provider, host user and normalized time and fences review identities", async () => {
			const metadata = {
				installationId: "installation",
				tediId: "tedi",
				hostOrganizationId: "tenant",
				hostUserId: "person",
				origin: "https://example.test",
			};
			const event = (
				id: string,
				overrides: Partial<NewWidgetEvent> = {},
			): NewWidgetEvent => ({
				id,
				organizationId: "org",
				appId: "app",
				sessionId: "session",
				eventType: "attention_review",
				widgetKey: "quiet",
				metadata,
				createdAt: at,
				...overrides,
			});
			await trackWidgetEvent(
				db,
				event("review", { createdAt: "2026-09-01T14:00:00+02:00" }),
			);
			await trackEmbeddedAttentionOutcome(db, event("review"));
			await trackWidgetEvents(db, [
				event("busy-1", {
					widgetKey: "busy",
					createdAt: "2026-09-01T12:01:00.000Z",
				}),
				event("busy-2", {
					widgetKey: "busy",
					createdAt: "2026-09-01T12:02:00.000Z",
				}),
				event("wrong-user", {
					metadata: { ...metadata, hostUserId: "someone" },
				}),
				event("wrong-org", {
					organizationId: "other",
					appId: "other-app",
					metadata: { ...metadata, installationId: "other-installation" },
				}),
			]);
			expect(
				await listEmbeddedProviderActivity(db, {
					providerOrganizationId: "org",
					from: at,
					to: at,
					limit: 10,
					installationId: "installation",
					hostUserId: "person",
				}),
			).toMatchObject([
				{ id: "review", installationId: "installation", hostUserId: "person" },
			]);
			expect(
				await listEmbeddedProviderActivity(db, {
					providerOrganizationId: "org",
					from: at,
					to: "2026-09-02T00:00:00.000Z",
					limit: 10,
					installationId: "other-installation",
				}),
			).toEqual([]);
			expect(
				await listEmbeddedAttentionReviews(db, {
					organizationId: "org",
					appId: "app",
					...metadata,
					attentionRefs: ["quiet", "busy"],
				}),
			).toEqual([
				{ attentionRef: "quiet", reviewedAt: "2026-09-01T14:00:00+02:00" },
				{ attentionRef: "busy", reviewedAt: "2026-09-01T12:02:00.000Z" },
			]);
		});
	});
