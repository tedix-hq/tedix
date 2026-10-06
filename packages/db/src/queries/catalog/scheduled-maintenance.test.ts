import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import {
	getCatalogEnrichmentHealth,
	listEnabledCatalogAppsForVectorSync,
} from "./scheduled-maintenance";

function realDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE app_catalog (
			id TEXT PRIMARY KEY NOT NULL,
			slug TEXT,
			name TEXT NOT NULL DEFAULT '',
			description TEXT,
			model_description TEXT,
			mcp_endpoint_normalized TEXT,
			connector_type TEXT NOT NULL,
			status TEXT DEFAULT 'ENABLED',
			category TEXT,
			developer TEXT,
			is_discoverable INTEGER DEFAULT 1,
			keywords_for_discovery TEXT,
			keywords_for_triggering TEXT,
			seo_description TEXT,
			categories TEXT,
			has_writes INTEGER DEFAULT 0,
			has_interactive INTEGER DEFAULT 0,
			mcp_tool_count INTEGER DEFAULT 0,
			health_status TEXT DEFAULT 'unknown',
			rich_content TEXT
		);
	`);
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

describe("getCatalogEnrichmentHealth", () => {
	it("reads enrichment state from rich_content instead of the removed enriched_at column", async () => {
		const { db, sqlite } = realDb();
		const insert = sqlite.prepare(
			"INSERT INTO app_catalog (id, connector_type, is_discoverable, rich_content) VALUES (?, ?, ?, ?)",
		);
		insert.run("mcp-never", "MCP", 1, null);
		insert.run("mcp-missing-field", "MCP", 1, "{}");
		insert.run(
			"mcp-enriched",
			"MCP",
			1,
			JSON.stringify({ enrichedAt: "2026-08-01T00:00:00.000Z" }),
		);
		insert.run("mcp-hidden", "MCP", 0, null);
		insert.run("rest-never", "REST", 1, null);

		await expect(getCatalogEnrichmentHealth(db)).resolves.toEqual({
			needsEnrichment: 2,
			totalMcp: 3,
		});
	});

	it("returns zeroes for an empty catalog", async () => {
		const { db } = realDb();
		await expect(getCatalogEnrichmentHealth(db)).resolves.toEqual({
			needsEnrichment: 0,
			totalMcp: 0,
		});
	});
});

describe("listEnabledCatalogAppsForVectorSync", () => {
	it("returns deterministic bounded pages and excludes disabled apps", async () => {
		const { db, sqlite } = realDb();
		const insert = sqlite.prepare(
			"INSERT INTO app_catalog (id, slug, name, connector_type, status) VALUES (?, ?, ?, 'MCP', ?)",
		);
		insert.run("c", "c", "C", "ENABLED");
		insert.run("a", "a", "A", "ENABLED");
		insert.run("b", "b", "B", "ENABLED");
		insert.run("disabled", "disabled", "Disabled", "DISABLED");

		const page = await listEnabledCatalogAppsForVectorSync(db, {
			limit: 2,
			offset: 1,
		});

		expect(page.map((app) => app.id)).toEqual(["b", "c"]);
	});
});
