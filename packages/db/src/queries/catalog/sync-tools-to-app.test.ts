import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { appCatalog, appCatalogMcpTools } from "../../schema/catalog";
import { connectionProviders } from "../../schema/connection-providers";
import { apps, appTools, skillEntries } from "../../schema/index";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { batchNonEmpty } from "../../utils/batch";
import {
	buildCatalogMcpConnectionAuth,
	syncCatalogToolsToApp,
} from "./sync-tools-to-app";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			appCatalog,
			appCatalogMcpTools,
			apps,
			appTools,
			connectionProviders,
			skillEntries,
		),
	);
	const facade = createD1Facade(sqlite);
	let batchCalls = 0;
	const originalBatch = facade.batch.bind(facade);
	facade.batch = ((statements) => {
		batchCalls++;
		return originalBatch(statements);
	}) as D1Database["batch"];
	return {
		db: createDbClient(facade),
		batchCalls: () => batchCalls,
		resetBatchCalls: () => {
			batchCalls = 0;
		},
	};
}

describe("buildCatalogMcpConnectionAuth", () => {
	it("preserves provider-specific Basic authentication on catalog MCP tools", () => {
		expect(
			buildCatalogMcpConnectionAuth({
				connectionProviderId: "dataforseo-api-key",
				connectionScope: "tenant",
				credentialProfile: {
					authHeader: "Authorization",
					authTemplate: "Basic {token}",
				},
			}),
		).toEqual({
			type: "connection",
			connectionId: "dataforseo-api-key",
			scope: "tenant",
			credentialScope: "tenant",
			header: "Authorization",
			template: "Basic {token}",
		});
	});

	it("keeps base64 encoding and client-credentials exchange metadata", () => {
		expect(
			buildCatalogMcpConnectionAuth({
				connectionProviderId: "example",
				connectionScope: "hybrid",
				connectionScopes: ["read"],
				credentialProfile: {
					authEncoding: "base64",
				},
				clientCredentialsTokenUrl: "https://example.com/oauth/token",
			}),
		).toMatchObject({
			credentialPreference: "user-first",
			scopes: ["read"],
			encoding: "base64",
			clientCredentials: {
				tokenUrl: "https://example.com/oauth/token",
			},
		});
	});

	it("returns undefined when the app has no connection provider", () => {
		expect(
			buildCatalogMcpConnectionAuth({
				connectionScope: "tenant",
			}),
		).toBeUndefined();
	});

	it("batches an 89-tool catalog into one base-app mutation round trip", async () => {
		const { db, batchCalls, resetBatchCalls } = setup();
		const catalogAppId = "catalog-dataforseo";
		const appId = "app-dataforseo";

		await db.insert(appCatalog).values({
			id: catalogAppId,
			name: "DataForSEO",
			slug: "dataforseo",
			toolSource: "upstream_mcp",
			connectorType: "MCP",
			authTypes: ["API_KEY"],
			lastSyncedAt: "2026-08-02T00:00:00.000Z",
		});
		await db.insert(apps).values({
			id: appId,
			organizationId: "platform-org",
			name: "DataForSEO",
			slug: "dataforseo",
			visibility: "public",
			catalogAppId,
			metadata: {
				mcpConfig: {
					upstreamMcpUrl: "https://mcp.dataforseo.com/mcp",
				},
			},
		});
		await db.insert(connectionProviders).values({
			id: "dataforseo-api-key",
			name: "DataForSEO API Key",
			description: "Official DataForSEO MCP access",
			icon: "key",
			category: "analytics",
			type: "api_key",
			descopeAppId: "dataforseo-api-key",
			recommendedScope: "tenant",
			supportedScopes: ["tenant"],
			requiredScopes: [],
			credentialProfile: {
				authHeader: "Authorization",
				authTemplate: "Basic {token}",
			},
		});

		await db.batch(
			batchNonEmpty(
				Array.from({ length: 89 }, (_, index) =>
					db.insert(appCatalogMcpTools).values({
						id: `catalog-tool-${index}`,
						catalogAppId,
						toolName: `dataforseo_tool_${index}`,
						title: `DataForSEO Tool ${index}`,
						description: `Official DataForSEO tool ${index}`,
						detectedAt: "2026-08-02T00:00:00.000Z",
						lastSeenAt: "2026-08-02T00:00:00.000Z",
						inputSchema: {
							type: "object",
							properties: { keyword: { type: "string" } },
						},
					}),
				),
			),
		);
		resetBatchCalls();

		const syncInput = {
			catalogAppId,
			appId,
			mcpServerUrl: "https://mcp.dataforseo.com/mcp",
			connectionProviderId: "dataforseo-api-key",
			connectionScope: "tenant" as const,
			dryRun: false,
		};
		const result = await syncCatalogToolsToApp(db, syncInput);

		expect(result.summary).toContain("89 created");
		expect(batchCalls()).toBe(1);

		const staleTools = await db
			.select({ id: appTools.id, config: appTools.config })
			.from(appTools)
			.where(eq(appTools.appId, appId))
			.limit(2);
		for (const tool of staleTools) {
			await db
				.update(appTools)
				.set({
					config: {
						...tool.config,
						auth: {
							type: "connection",
							connectionId: "dataforseo-api-key",
							scope: "tenant",
							credentialScope: "tenant",
						},
					},
				})
				.where(eq(appTools.id, tool.id));
		}
		resetBatchCalls();

		const repair = await syncCatalogToolsToApp(db, syncInput);
		expect(repair.summary).toContain("2 updated");
		expect(batchCalls()).toBe(1);
		const tools = await db
			.select({ config: appTools.config })
			.from(appTools)
			.where(eq(appTools.appId, appId));
		expect(tools).toHaveLength(89);
		for (const tool of tools) {
			expect(tool.config?.auth).toMatchObject({
				type: "connection",
				connectionId: "dataforseo-api-key",
				scope: "tenant",
				header: "Authorization",
				template: "Basic {token}",
			});
		}

		const [app] = await db
			.select({ metadata: apps.metadata })
			.from(apps)
			.where(eq(apps.id, appId));
		expect(app?.metadata?.mcpConfig?.upstreamMcpUrl).toBeUndefined();
	});
});

describe("syncCatalogToolsToApp write capability", () => {
	async function seed(db: ReturnType<typeof setup>["db"]) {
		await db.insert(appCatalog).values({
			id: "catalog-wc",
			name: "Acme",
			slug: "acme",
			toolSource: "upstream_mcp",
			connectorType: "MCP",
			authTypes: ["API_KEY"],
			lastSyncedAt: "2026-08-18T00:00:00.000Z",
		});
		await db.insert(apps).values({
			id: "app-wc",
			organizationId: "platform-org",
			name: "Acme",
			slug: "acme",
			visibility: "public",
			catalogAppId: "catalog-wc",
		});
	}

	const catalogTool = (
		id: string,
		toolName: string,
		annotations: Record<string, boolean> | null,
	) => ({
		id,
		catalogAppId: "catalog-wc",
		toolName,
		title: toolName,
		description: toolName,
		detectedAt: "2026-08-18T00:00:00.000Z",
		lastSeenAt: "2026-08-18T00:00:00.000Z",
		inputSchema: { type: "object" as const, properties: {} },
		...(annotations ? { annotations } : {}),
	});

	it("populates write_capability from upstream annotations, leaving unannotated tools UNDECLARED", async () => {
		const { db } = setup();
		await seed(db);
		await db.batch(
			batchNonEmpty([
				db.insert(appCatalogMcpTools).values(
					catalogTool("ct-1", "acme_delete_thing", {
						destructiveHint: true,
					}),
				),
				db
					.insert(appCatalogMcpTools)
					.values(
						catalogTool("ct-2", "acme_get_thing", { readOnlyHint: true }),
					),
				db.insert(appCatalogMcpTools).values(
					catalogTool("ct-3", "acme_edit_thing", {
						readOnlyHint: false,
					}),
				),
				// The production shape: upstream sends nothing at all.
				db
					.insert(appCatalogMcpTools)
					.values(catalogTool("ct-4", "createJiraIssue", null)),
			]),
		);

		await syncCatalogToolsToApp(db, {
			catalogAppId: "catalog-wc",
			appId: "app-wc",
			mcpServerUrl: "https://mcp.acme.test/mcp",
			dryRun: false,
		});

		const rows = await db
			.select({
				toolId: appTools.toolId,
				writeCapability: appTools.writeCapability,
			})
			.from(appTools)
			.where(eq(appTools.appId, "app-wc"));
		const byTool = new Map(rows.map((r) => [r.toolId, r.writeCapability]));
		expect(byTool.get("acme_delete_thing")).toBe("destructive");
		expect(byTool.get("acme_get_thing")).toBe("read");
		expect(byTool.get("acme_edit_thing")).toBe("write");
		// UNDECLARED, NOT "read" — this is the row the gates must fail closed on.
		expect(byTool.get("createJiraIssue")).toBeNull();
	});

	// The remediation path for the ~52 third-party tools whose upstream sends no
	// annotations at all: an operator declares the capability by hand. A routine
	// sync used to erase it, reported as an unremarkable "1 updated" with a null
	// reason, so the unclassified report could never shrink for exactly the rows
	// it exists to surface — and at the apps/mcp destructive gate the swing was
	// GATED -> UNGATED, not fail-safe.
	it("preserves an operator declaration when upstream sends no annotations", async () => {
		const { db } = setup();
		await seed(db);
		await db
			.insert(appCatalogMcpTools)
			.values(catalogTool("ct-4", "createJiraIssue", null));
		const syncInput = {
			catalogAppId: "catalog-wc",
			appId: "app-wc",
			mcpServerUrl: "https://mcp.acme.test/mcp",
			dryRun: false,
		};
		await syncCatalogToolsToApp(db, syncInput);

		// Operator classifies it by hand — `annotations` deliberately untouched,
		// which is exactly what `updateAppTool` writes.
		await db
			.update(appTools)
			.set({ writeCapability: "destructive" })
			.where(eq(appTools.appId, "app-wc"));

		await syncCatalogToolsToApp(db, syncInput);

		const [row] = await db
			.select({
				writeCapability: appTools.writeCapability,
				annotations: appTools.annotations,
			})
			.from(appTools)
			.where(eq(appTools.appId, "app-wc"));
		expect(row?.writeCapability).toBe("destructive");
		// A null derivation carries no information, so it must not contradict.
		expect(row?.annotations ?? null).toBeNull();
	});

	it("still lets upstream win when it actually declares something", async () => {
		// The other direction must keep working: a tool that upstream changes
		// from read-only to destructive has to re-derive, or a stale declaration
		// would permanently ungate it.
		const { db } = setup();
		await seed(db);
		await db
			.insert(appCatalogMcpTools)
			.values(catalogTool("ct-1", "acme_thing_op", { readOnlyHint: true }));
		const syncInput = {
			catalogAppId: "catalog-wc",
			appId: "app-wc",
			mcpServerUrl: "https://mcp.acme.test/mcp",
			dryRun: false,
		};
		await syncCatalogToolsToApp(db, syncInput);

		await db
			.update(appCatalogMcpTools)
			.set({ annotations: { destructiveHint: true } })
			.where(eq(appCatalogMcpTools.id, "ct-1"));
		await syncCatalogToolsToApp(db, syncInput);

		const [row] = await db
			.select({ writeCapability: appTools.writeCapability })
			.from(appTools)
			.where(eq(appTools.appId, "app-wc"));
		expect(row?.writeCapability).toBe("destructive");
	});

	it("re-syncs a row whose annotations were already right but whose column is NULL", async () => {
		// Rows written before the column existed. Without a dedicated change
		// check the sync would report "Already in sync" and they would stay
		// unclassified forever.
		const { db } = setup();
		await seed(db);
		await db
			.insert(appCatalogMcpTools)
			.values(catalogTool("ct-1", "acme_get_thing", { readOnlyHint: true }));
		const syncInput = {
			catalogAppId: "catalog-wc",
			appId: "app-wc",
			mcpServerUrl: "https://mcp.acme.test/mcp",
			dryRun: false,
		};
		await syncCatalogToolsToApp(db, syncInput);
		await db
			.update(appTools)
			.set({ writeCapability: null })
			.where(eq(appTools.appId, "app-wc"));

		const result = await syncCatalogToolsToApp(db, syncInput);
		expect(result.summary).toContain("1 updated");
		const [row] = await db
			.select({ writeCapability: appTools.writeCapability })
			.from(appTools)
			.where(eq(appTools.appId, "app-wc"));
		expect(row?.writeCapability).toBe("read");
	});
	it.each([
		"unchanged",
		"input-schema",
		"output-schema",
		"upstream-url",
		"source-hash",
		"credentials",
	])(
		"keeps read review only for unchanged execution contracts: %s",
		async (change) => {
			const { db } = setup();
			await seed(db);
			await db
				.insert(appCatalogMcpTools)
				.values(
					catalogTool("ct-reviewed", "acme_get_thing", { readOnlyHint: true }),
				);
			const input = {
				catalogAppId: "catalog-wc",
				appId: "app-wc",
				mcpServerUrl: "https://mcp.acme.test/mcp",
				dryRun: false,
			};
			await syncCatalogToolsToApp(db, input);
			const [original] = await db
				.select()
				.from(appTools)
				.where(eq(appTools.appId, "app-wc"));
			await db
				.update(appTools)
				.set({ config: { ...original!.config, connectionReadOnly: true } })
				.where(eq(appTools.id, original!.id));
			if (change === "input-schema")
				await db
					.update(appCatalogMcpTools)
					.set({
						inputSchema: {
							type: "object",
							properties: { action: { type: "string" } },
						},
					})
					.where(eq(appCatalogMcpTools.id, "ct-reviewed"));
			if (change === "output-schema")
				await db
					.update(appCatalogMcpTools)
					.set({
						outputSchema: {
							type: "object",
							properties: { result: { type: "string" } },
						},
					})
					.where(eq(appCatalogMcpTools.id, "ct-reviewed"));
			if (change === "source-hash")
				await db
					.update(appTools)
					.set({ schemaSourceHash: "obsolete-reviewed-source" })
					.where(eq(appTools.id, original!.id));
			const updatedInput = {
				...input,
				...(change === "upstream-url"
					? { mcpServerUrl: "https://changed.acme.test/mcp" }
					: {}),
				...(change === "credentials"
					? { connectionProviderId: "acme", connectionScope: "tenant" as const }
					: {}),
			};
			await syncCatalogToolsToApp(db, { ...updatedInput, dryRun: true });
			const [beforeApply] = await db
				.select()
				.from(appTools)
				.where(eq(appTools.id, original!.id));
			expect(beforeApply!.config?.connectionReadOnly).toBe(true);
			await syncCatalogToolsToApp(db, updatedInput);
			const [row] = await db
				.select()
				.from(appTools)
				.where(eq(appTools.id, original!.id));
			expect(row!.writeCapability).toBe("read");
			expect(row!.annotations?.readOnlyHint).toBe(true);
			expect(row!.config?.connectionReadOnly).toBe(change === "unchanged");
		},
	);
});
