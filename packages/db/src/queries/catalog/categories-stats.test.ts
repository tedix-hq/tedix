import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { mergeCatalogCategoryCounts } from "@tedix/api-contract/utils/catalog-categories";
import { getCatalogCategories, getCatalogStats } from "./categories-stats";

const categoryMigration = readFileSync(
	new URL(
		"../../../drizzle/20261118151634_catalog-category-totals/migration.sql",
		import.meta.url,
	),
	"utf8",
);

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
			has_writes INTEGER,
			explore_shadowed INTEGER NOT NULL DEFAULT 0
		);
		CREATE TABLE app_catalog_store_listings (
			id TEXT PRIMARY KEY,
			catalog_app_id TEXT NOT NULL,
			source TEXT NOT NULL
		);
	`);
	sqlite.exec(categoryMigration);
	sqlite.exec(
		readFileSync(
			new URL(
				"../../../drizzle/20261012225830_catalog-browse-totals/migration.sql",
				import.meta.url,
			),
			"utf8",
		),
	);
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
		sqlite,
		db: createDbClient(createD1Facade(sqlite)),
		insertApp,
		insertListing,
	};
}

describe("public catalog statistics", () => {
	it("counts listings across indexed pages, including an entirely hidden first page", async () => {
		const { sqlite, insertApp, insertListing } = fixture();
		for (const [id, discoverable] of [
			["public", 1],
			["hidden", 0],
		] as const) {
			insertApp.run(
				id,
				id,
				"MCP",
				"OAI",
				"ENABLED",
				"RELEASED",
				discoverable,
				"BUSINESS",
				0,
				0,
			);
		}
		for (let i = 0; i < 2505; i++) {
			insertListing.run(
				String(i).padStart(5, "0"),
				i < 1000 ? "hidden" : "public",
				i < 1000 ? "claude" : i < 2000 ? "chatgpt" : "official",
			);
		}
		insertListing.run("orphan", "missing", "orphan");
		const plans: string[] = [];
		const db = createDbClient(
			createD1Facade({
				exec: (query) => sqlite.exec(query),
				prepare(query) {
					if (query.startsWith('with "listing_page"')) {
						plans.push(
							sqlite
								.prepare(`EXPLAIN QUERY PLAN ${query}`)
								.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
								.map((row) => row.detail)
								.join(" "),
						);
					}
					return sqlite.prepare(query);
				},
			}),
		);
		for (const includeUntrusted of [false, true]) {
			plans.length = 0;
			expect(
				(await getCatalogStats(db, includeUntrusted)).sourceBreakdown,
			).toEqual([
				{ source: "chatgpt", count: 1000 },
				...(includeUntrusted ? [{ source: "claude", count: 1000 }] : []),
				{ source: "official", count: 505 },
			]);
			expect(plans).toHaveLength(4);
			for (const plan of plans) {
				expect(plan).toMatch(/(?:MATERIALIZE|CO-ROUTINE) listing_page/);
				expect(plan).toMatch(
					/SEARCH app_catalog USING (?:COVERING )?INDEX sqlite_autoindex_app_catalog_1 \(id=\?\) LEFT-JOIN/,
				);
				expect(plan).not.toContain("SCAN app_catalog ");
			}
			for (const plan of plans.slice(1)) {
				expect(plan).toContain(
					"SEARCH app_catalog_store_listings USING INDEX sqlite_autoindex_app_catalog_store_listings_1 (id>?)",
				);
			}
		}
		sqlite.close();
	});

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

describe("maintained category counts", () => {
	it("backfills and follows category, visibility and lifecycle changes without reading catalog rows", async () => {
		const { sqlite, insertApp } = fixture();
		insertApp.run(
			"one",
			"One",
			"MCP",
			"OAI",
			"ENABLED",
			"RELEASED",
			1,
			"BUSINESS",
			0,
			0,
		);
		insertApp.run(
			"two",
			"Two",
			"MCP",
			"THIRD_PARTY",
			"ENABLED",
			"RELEASED",
			1,
			"DESIGN",
			0,
			0,
		);
		insertApp.run(
			"null",
			"Null",
			"MCP",
			"TRUSTED_PARTNER",
			"ENABLED",
			"RELEASED",
			1,
			null,
			0,
			0,
		);
		// Apply the real migration to populated input as well as an empty catalog.
		sqlite.exec(
			"DROP TRIGGER app_catalog_category_insert; DROP TRIGGER app_catalog_category_delete; DROP TRIGGER app_catalog_category_update; DROP TABLE app_catalog_category_totals;",
		);
		sqlite.exec(categoryMigration);
		sqlite.exec(
			readFileSync(
				new URL(
					"../../../drizzle/20261118152346_catalog-category-total-index/migration.sql",
					import.meta.url,
				),
				"utf8",
			),
		);
		const queries: string[] = [];
		const db = createDbClient(
			createD1Facade({
				prepare(query) {
					queries.push(query);
					return sqlite.prepare(query);
				},
				exec(query) {
					sqlite.exec(query);
				},
			}),
		);
		const accurate = async () => {
			const expected = sqlite
				.prepare(`SELECT category AS name, count(*) AS count FROM app_catalog
				WHERE is_discoverable = 1 AND status = 'ENABLED' AND review_status = 'RELEASED'
				AND developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY') GROUP BY category`)
				.all() as { name: string | null; count: number }[];
			expect(await getCatalogCategories(db)).toEqual(
				mergeCatalogCategoryCounts(expected),
			);
		};
		await accurate();
		for (const statement of [
			"UPDATE app_catalog SET category = 'DESIGN' WHERE id = 'one'",
			"UPDATE app_catalog SET category = NULL WHERE id = 'two'",
			"UPDATE app_catalog SET category = '' WHERE id = 'null'",
			"UPDATE app_catalog SET is_discoverable = 0 WHERE id = 'one'",
			"UPDATE app_catalog SET is_discoverable = 1, category = 'BUSINESS' WHERE id = 'one'",
			"UPDATE app_catalog SET developer_type = 'COMMUNITY' WHERE id = 'one'",
			"UPDATE app_catalog SET developer_type = 'OAI' WHERE id = 'one'",
			"UPDATE app_catalog SET status = 'DISABLED' WHERE id = 'one'",
			"UPDATE app_catalog SET status = 'ENABLED', review_status = NULL WHERE id = 'one'",
			"UPDATE app_catalog SET review_status = 'RELEASED' WHERE id = 'one'",
			"UPDATE app_catalog SET developer_type = NULL WHERE id = 'one'",
			"DELETE FROM app_catalog",
		]) {
			sqlite.exec(statement);
			await accurate();
		}
		expect(
			sqlite
				.prepare("SELECT * FROM app_catalog_category_totals WHERE total > 0")
				.all(),
		).toEqual([]);
		expect(
			queries.every(
				(query) =>
					query.includes('"app_catalog_category_totals"') &&
					!query.includes('"app_catalog"'),
			),
		).toBe(true);
		for (const query of queries) {
			const plan = sqlite
				.prepare(`EXPLAIN QUERY PLAN ${query}`)
				.all(0)
				.map((row) => String(row.detail))
				.join(" | ");
			expect(plan).toContain(
				"SEARCH app_catalog_category_totals USING COVERING INDEX app_catalog_category_total_idx (total>?)",
			);
			expect(plan).not.toContain("TEMP B-TREE");
		}
		sqlite.close();
	});
});
