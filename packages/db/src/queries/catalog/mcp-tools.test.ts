import { DatabaseSync } from "node:sqlite";
import { and, eq, isNull } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import {
	appCatalog,
	appCatalogMcpPrompts,
	appCatalogMcpResourceTemplates,
	appCatalogMcpTools,
	upstreamDriftReports,
} from "../../schema/catalog";
import { apps } from "../../schema/apps";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	checkCatalogIntegrity,
	syncCatalogMcpPrompts,
	syncCatalogMcpResourceTemplates,
	syncCatalogMcpTools,
} from "./mcp-tools";

const CATALOG_APP_ID = "catalog-dataforseo";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(
		schemaDdl(
			appCatalog,
			appCatalogMcpTools,
			appCatalogMcpResourceTemplates,
			appCatalogMcpPrompts,
			upstreamDriftReports,
			apps,
		),
	);
	const facade = createD1Facade(sqlite);
	let batchCalls = 0;
	const originalBatch = facade.batch.bind(facade);
	facade.batch = ((statements) => {
		batchCalls++;
		return originalBatch(statements);
	}) as D1Database["batch"];
	return { db: createDbClient(facade), batchCalls: () => batchCalls };
}

describe("syncCatalogMcpTools", () => {
	it("reconciles write labels through full and partial inventories", async () => {
		const { db } = setup();
		await db.insert(appCatalog).values({
			id: CATALOG_APP_ID,
			name: "Docs",
			slug: "docs",
			connectorType: "MCP",
			lastSyncedAt: "2026-09-20T00:00:00.000Z",
			hasWrites: false,
		});
		const read = { name: "list_pages", annotations: { readOnlyHint: true } };
		const write = { name: "publish", annotations: { readOnlyHint: false } };
		const label = async () =>
			(await db.select({ hasWrites: appCatalog.hasWrites }).from(appCatalog))[0]
				?.hasWrites;
		await syncCatalogMcpTools(db, CATALOG_APP_ID, [read, write]);
		expect(await label()).toBe(true);
		await syncCatalogMcpTools(db, CATALOG_APP_ID, [read], { mode: "partial" });
		expect(await label()).toBe(true);
		await syncCatalogMcpTools(db, CATALOG_APP_ID, [read]);
		expect(await label()).toBe(false);
		await syncCatalogMcpTools(db, CATALOG_APP_ID, [{ name: "unknown" }]);
		expect(await label()).toBe(true);
		await syncCatalogMcpTools(db, CATALOG_APP_ID, []);
		expect(await label()).toBe(false);
	});

	it("stores only ToolAnnotations keys and parks upstream extras in _meta", async () => {
		const { db } = setup();
		await db.insert(appCatalog).values({
			id: CATALOG_APP_ID,
			name: "Slides",
			slug: "slides",
			connectorType: "MCP",
			lastSyncedAt: "2026-09-20T00:00:00.000Z",
		});
		const tool = {
			name: "render_deck",
			annotations: {
				title: "Render deck",
				readOnlyHint: false,
				cost: { usd: 0.02, unit: "call", note: "per render" },
				"x-openai-isConsequential": true,
			},
			_meta: { audience: ["user"] },
		};
		await syncCatalogMcpTools(db, CATALOG_APP_ID, [
			tool as Parameters<typeof syncCatalogMcpTools>[2][number],
		]);
		const [row] = await db
			.select({
				annotations: appCatalogMcpTools.annotations,
				meta: appCatalogMcpTools.meta,
			})
			.from(appCatalogMcpTools);
		expect(row).toEqual({
			annotations: { title: "Render deck", readOnlyHint: false },
			meta: {
				audience: ["user"],
				"tedix/upstreamAnnotations": {
					cost: { usd: 0.02, unit: "call", note: "per render" },
					"x-openai-isConsequential": true,
				},
			},
		});
	});

	it("repairs a stale positive count with no snapshot rows, only in apply mode", async () => {
		const { db } = setup();
		await db.insert(appCatalog).values({
			id: CATALOG_APP_ID,
			name: "Empty snapshot",
			slug: "empty-snapshot",
			status: "ENABLED",
			toolSource: "upstream_mcp",
			connectorType: "MCP",
			mcpToolCount: 25,
			lastSyncedAt: "2026-09-05T00:00:00.000Z",
		});
		const options = { catalogAppId: CATALOG_APP_ID };
		const dry = await checkCatalogIntegrity(db, options);
		expect(
			dry.issues.some((issue) => issue.code === "tool_count_mismatch"),
		).toBe(true);
		expect(dry.repaired.toolCounts).toBe(0);
		const [before] = await db
			.select({ count: appCatalog.mcpToolCount })
			.from(appCatalog);
		expect(before?.count).toBe(25);
		const applied = await checkCatalogIntegrity(db, {
			...options,
			apply: true,
		});
		expect(applied.repaired.toolCounts).toBe(1);
		expect(
			applied.issues.some((issue) => issue.code === "tool_count_mismatch"),
		).toBe(false);
		const [after] = await db
			.select({ count: appCatalog.mcpToolCount })
			.from(appCatalog);
		expect(after?.count).toBe(0);
		expect(
			(await checkCatalogIntegrity(db, { ...options, apply: true })).repaired
				.toolCounts,
		).toBe(0);
	});
	it("batches a large official MCP inventory into one D1 round trip", async () => {
		const { db, batchCalls } = setup();
		await db.insert(appCatalog).values({
			id: CATALOG_APP_ID,
			name: "DataForSEO",
			slug: "dataforseo",
			toolSource: "upstream_mcp",
			connectorType: "MCP",
			lastSyncedAt: "2026-08-02T00:00:00.000Z",
		});

		const tools = Array.from({ length: 89 }, (_, index) => ({
			name: `dataforseo_tool_${index}`,
			description: `DataForSEO tool ${index}`,
			inputSchema: {
				type: "object" as const,
				properties: { keyword: { type: "string" } },
			},
			execution: {
				taskSupport: "forbidden" as const,
			},
		}));

		const result = await syncCatalogMcpTools(db, CATALOG_APP_ID, tools);

		expect(result).toMatchObject({ added: 89, updated: 0, removed: 0 });
		expect(batchCalls()).toBe(1);
		expect(
			await db.$count(
				appCatalogMcpTools,
				and(
					eq(appCatalogMcpTools.catalogAppId, CATALOG_APP_ID),
					isNull(appCatalogMcpTools.removedAt),
				),
			),
		).toBe(89);

		const [catalogApp] = await db
			.select({ mcpToolCount: appCatalog.mcpToolCount })
			.from(appCatalog)
			.where(eq(appCatalog.id, CATALOG_APP_ID));
		expect(catalogApp?.mcpToolCount).toBe(89);
	});
});

describe("catalog MCP metadata sync", () => {
	it("preserves resource template metadata and prompt definition metadata", async () => {
		const { db } = setup();
		await db.insert(appCatalog).values({
			id: CATALOG_APP_ID,
			name: "Docs",
			slug: "docs",
			connectorType: "MCP",
			lastSyncedAt: "2026-09-20T00:00:00.000Z",
		});
		const icon = { src: "https://example.test/icon.svg", sizes: ["48x48"] };
		const annotations = {
			audience: ["assistant" as const],
			priority: 0.7,
			lastModified: "2026-09-22T10:00:00Z",
		};
		const meta = { "vendor.example/extension": { enabled: true } };

		await syncCatalogMcpResourceTemplates(db, CATALOG_APP_ID, [
			{
				name: "page-template",
				title: "Page template",
				uriTemplate: "docs://pages/{pageId}",
				description: "Read a page",
				mimeType: "text/markdown",
				icons: [icon],
				annotations,
				_meta: meta,
			},
		]);
		await syncCatalogMcpPrompts(db, CATALOG_APP_ID, [
			{
				name: "summarize_page",
				title: "Summarize a page",
				description: "Summarize the requested page",
				arguments: [{ name: "pageId", description: "Page id", required: true }],
				icons: [icon],
				annotations,
				_meta: meta,
			},
		]);

		expect(
			await db.select().from(appCatalogMcpResourceTemplates),
		).toMatchObject([
			{
				name: "page-template",
				title: "Page template",
				icons: [icon],
				annotations,
				meta,
			},
		]);
		expect(await db.select().from(appCatalogMcpPrompts)).toMatchObject([
			{
				promptName: "summarize_page",
				title: "Summarize a page",
				icons: [icon],
				annotations,
				meta,
			},
		]);
	});
});
