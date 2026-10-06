import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { getCatalogCategories, getCatalogStats } from "./categories-stats";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE app_catalog (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			connector_type TEXT NOT NULL,
			developer_type TEXT,
			status TEXT,
			review_status TEXT,
			is_discoverable INTEGER,
			category TEXT,
			has_interactive INTEGER,
			has_writes INTEGER
		);
		CREATE TABLE app_catalog_store_listings (
			id TEXT PRIMARY KEY,
			catalog_app_id TEXT NOT NULL,
			source TEXT NOT NULL
		);
	`);
	const insertApp = sqlite.prepare(`
		INSERT INTO app_catalog (
			id, name, connector_type, developer_type, status, review_status,
			is_discoverable, category, has_interactive, has_writes
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
	`);
	const insertListing = sqlite.prepare(
		"INSERT INTO app_catalog_store_listings (id, catalog_app_id, source) VALUES (?, ?, ?)",
	);
	return {
		db: createDbClient(createD1Facade(sqlite)),
		insertApp,
		insertListing,
	};
}

describe("public catalog statistics", () => {
	it("counts only the enabled, discoverable, released public catalog cohort", async () => {
		const { db, insertApp, insertListing } = fixture();
		insertApp.run(
			"public",
			"Public app",
			"MCP",
			"THIRD_PARTY",
			"ENABLED",
			"RELEASED",
			1,
			"BUSINESS",
			1,
			1,
		);
		insertApp.run(
			"disabled",
			"Disabled app",
			"MCP",
			"THIRD_PARTY",
			"DISABLED",
			"RELEASED",
			1,
			"BUSINESS",
			1,
			1,
		);
		insertApp.run(
			"draft",
			"Draft app",
			"MCP",
			"THIRD_PARTY",
			"ENABLED",
			"DRAFT",
			1,
			"DESIGN",
			1,
			1,
		);
		insertApp.run(
			"hidden",
			"Hidden app",
			"MCP",
			"THIRD_PARTY",
			"ENABLED",
			"RELEASED",
			0,
			"DESIGN",
			1,
			1,
		);
		insertApp.run(
			"untrusted",
			"Untrusted app",
			"MCP",
			"COMMUNITY",
			"ENABLED",
			"RELEASED",
			1,
			"DESIGN",
			1,
			1,
		);
		insertListing.run("listing-public", "public", "official");
		insertListing.run("listing-disabled", "disabled", "chatgpt");

		await expect(getCatalogStats(db, false)).resolves.toEqual({
			total: 1,
			mcp: 1,
			withInteractive: 1,
			withWrites: 1,
			sourceBreakdown: [{ source: "official", count: 1 }],
		});
		await expect(getCatalogCategories(db)).resolves.toEqual([
			{ name: "BUSINESS", label: "Business", count: 1 },
		]);
	});
});
