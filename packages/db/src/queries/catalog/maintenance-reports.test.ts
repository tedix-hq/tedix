import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { apps } from "../../schema/apps";
import {
	appCatalog,
	appCatalogMcpPrompts,
	appCatalogMcpResources,
	appCatalogMcpResourceTemplates,
	appCatalogMcpTools,
	appCatalogStoreListings,
	upstreamDriftReports,
} from "../../schema/catalog";
import { appTools } from "../../schema/tools";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { buildCatalogQualityReport } from "./maintenance-reports";

const NOW = "2026-10-20T12:00:00.000Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
	for (const sqlite of databases.splice(0)) sqlite.close();
});

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			appCatalog,
			appCatalogMcpTools,
			appCatalogMcpResources,
			appCatalogMcpResourceTemplates,
			appCatalogMcpPrompts,
			appCatalogStoreListings,
			apps,
			appTools,
			upstreamDriftReports,
		),
	);
	// Pin SQLite's clock; JavaScript fake timers do not affect SQL now.
	const d1 = createD1Facade(
		{
			prepare: (query) => sqlite.prepare(query.replaceAll("'now'", `'${NOW}'`)),
			exec: (query) => sqlite.exec(query),
		},
		{ maxBoundParams: 100 },
	);
	return { sqlite, d1, db: createDbClient(d1) };
}

type Db = ReturnType<typeof setup>["db"];

async function seedCatalog(
	db: Db,
	id: string,
	values: Partial<typeof appCatalog.$inferInsert> = {},
) {
	await db.insert(appCatalog).values({
		id,
		name: id,
		slug: id,
		connectorType: "MCP",
		status: "ENABLED",
		description:
			"A fictional catalog application with a complete public description for testing maintenance reports.",
		logoUrl: `https://assets.example.test/app_catalog/${id}.png`,
		richContent: {
			screenshotUrl: "https://assets.example.test/screenshot.png",
		},
		lastSyncedAt: NOW,
		...values,
	});
	await db.insert(appCatalogStoreListings).values({
		id: `listing-${id}`,
		catalogAppId: id,
		source: "chatgpt",
		sourceAppId: id,
		lastSyncedAt: NOW,
	});
}

describe("buildCatalogQualityReport stale boundary", () => {
	it.each([
		["tool", appCatalogMcpTools, { toolName: "list_entries" }],
		["resource", appCatalogMcpResources, { uri: "test://entries" }],
		[
			"resource_template",
			appCatalogMcpResourceTemplates,
			{ name: "entries", uriTemplate: "test://entries/{id}" },
		],
		["prompt", appCatalogMcpPrompts, { promptName: "summarize_entries" }],
	] as const)(
		"counts only active %s rows strictly older than the cutoff",
		async (entity, table, fields) => {
			const { db, d1 } = setup();
			await seedCatalog(db, "fictional-boundary");
			for (const [id, lastSeenAt, removedAt] of [
				["exact", "2026-10-06T12:00:00.000Z", null],
				["past", "2026-10-06T11:59:59.999Z", null],
				["recent", "2026-10-06T12:00:00.001Z", null],
				["removed", "2026-10-01T00:00:00.000Z", NOW],
			]) {
				await db.insert(table).values({
					id,
					catalogAppId: "fictional-boundary",
					detectedAt: NOW,
					lastSeenAt,
					removedAt,
					...Object.fromEntries(
						Object.entries(fields).map(([key, value]) => [
							key,
							`${value}-${id}`,
						]),
					),
				});
			}
			const report = await buildCatalogQualityReport(d1, {
				staleLastSeenDays: 14,
			});
			expect(report.issues).toEqual([
				expect.objectContaining({
					code: "stale_last_seen",
					severity: "warning",
					count: 1,
					summary: `fictional-boundary has 1 active ${entity} row(s) not seen in 14+ day(s).`,
					details: {
						entity,
						staleLastSeenDays: 14,
						oldestLastSeenAt: "2026-10-06T11:59:59.999Z",
						newestLastSeenAt: "2026-10-06T11:59:59.999Z",
					},
				}),
			]);
			expect(report.summary).toBe(
				"1 catalog quality issue(s): 0 error(s), 1 warning(s).",
			);
		},
	);
});
