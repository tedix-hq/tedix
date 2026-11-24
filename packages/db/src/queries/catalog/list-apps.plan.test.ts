import type { DatabaseSync } from "node:sqlite";
import { beforeAll, beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { getCatalogHealthSummary } from "./health-metrics";
import { listCatalogApps, type ListCatalogAppsOptions } from "./list-apps";

const PUBLIC = `developer_type IN ('TRUSTED_PARTNER', 'OAI', 'THIRD_PARTY')
	AND is_discoverable = 1 AND status = 'ENABLED' AND review_status = 'RELEASED'`;
const APPS = 4_000;

/**
 * A catalog with one large category (Finance, about half of it, stored under
 * two spellings), one small one (Design, 23 apps) and the rest spread over
 * three more. Every way an app can be hidden from the public list occurs in
 * every category, and some Finance apps share a name.
 */
function fixture(productionLikeStatistics: boolean) {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const insert = sqlite.prepare(`INSERT INTO app_catalog
		(id, name, connector_type, developer_type, is_discoverable, status, review_status, last_synced_at,
		 explore_shadowed, category, health_status, has_writes, source_created_at)
		VALUES (?, ?, 'MCP', ?, ?, ?, ?, '2026-01-01', ?, ?, ?, ?, ?)`);
	for (let i = 0; i < APPS; i++) {
		const category =
			i % 173 === 0
				? "DESIGN"
				: i % 2 === 0
					? i % 4 === 0
						? "FINANCE"
						: "finance"
					: ["PRODUCTIVITY", "TRAVEL", "HEALTH"][i % 3]!;
		insert.run(
			`app-${String(i).padStart(5, "0")}`,
			// Names are spread over the alphabet independently of the category;
			// every 97th app repeats its neighbour's name.
			`App ${String(((i - (i % 97 === 1 ? 2 : 0)) * 7919) % APPS).padStart(5, "0")}`,
			i % 53 === 0 ? null : i % 7 === 0 ? "OAI" : "THIRD_PARTY",
			i % 41 === 0 ? 0 : 1,
			i % 37 === 0 ? "DISABLED" : "ENABLED",
			i % 31 === 0 ? "PENDING" : "RELEASED",
			i % 5 === 0 ? 1 : 0,
			category,
			i % 3 === 0 ? "healthy" : i % 3 === 1 ? "unknown" : "degraded",
			i % 2,
			// Unique, so a page by date has one order.
			i % 11 === 0
				? null
				: new Date(Date.UTC(2026, 0, 1) + i * 60_000).toISOString(),
		);
	}
	if (productionLikeStatistics) sqlite.exec("ANALYZE");
	sqlite.exec("PRAGMA query_only = ON");
	const queries: string[] = [];
	const db = createDbClient(
		createD1Facade(sqlite, {
			onPrepare(query) {
				queries.push(query);
			},
		}),
	);
	return { sqlite, db, queries };
}

function explain(sqlite: DatabaseSync, query: string) {
	return sqlite
		.prepare(`EXPLAIN QUERY PLAN ${query}`)
		.all(...Array((query.match(/\?/g) ?? []).length).fill(null))
		.map((row) => String(row.detail))
		.join("\n");
}

/** The same list read with plain SQL, no index named and no paging tricks. */
function expected(sqlite: DatabaseSync, options: ListCatalogAppsOptions) {
	const where = [
		PUBLIC,
		options.hideShadowedVariants ? "explore_shadowed = 0" : "1",
		options.category === "FINANCE"
			? "category IN ('FINANCE','finance','Finance')"
			: options.category
				? `category = '${options.category}'`
				: "1",
		options.healthStatus ? `health_status = '${options.healthStatus}'` : "1",
		options.hasWrites === undefined
			? "1"
			: `has_writes = ${Number(options.hasWrites)}`,
	].join(" AND ");
	const direction = options.sortDir === "desc" ? "DESC" : "ASC";
	const order =
		options.sortBy === "sourceCreatedAt"
			? "coalesce(source_created_at, json_extract(first_seen, '$.at')) DESC, name ASC"
			: `name ${direction}, rowid ${direction}`;
	const { total } = sqlite
		.prepare(`SELECT count(*) AS total FROM app_catalog WHERE ${where}`)
		.get() as { total: number };
	const ids = sqlite
		.prepare(
			`SELECT id FROM app_catalog WHERE ${where} ORDER BY ${order} LIMIT ${options.limit ?? 100} OFFSET ${options.offset ?? 0}`,
		)
		.all()
		.map((row) => String(row.id));
	return { total, ids };
}

const FINANCE = { category: "FINANCE", hideShadowedVariants: true } as const;

describe("filtered public catalog pages", () => {
	let catalog: ReturnType<typeof fixture>;
	beforeAll(() => {
		catalog = fixture(true);
	});

	it.each<[string, ListCatalogAppsOptions]>([
		["with store variants", { category: "FINANCE", limit: 6 }],
		["descending", { ...FINANCE, limit: 24, sortDir: "desc" }],
		["past the last page", { ...FINANCE, limit: 50, offset: 5_000 }],
		[
			"a small category, second page",
			{ category: "DESIGN", hideShadowedVariants: true, limit: 6, offset: 6 },
		],
		["a category and a capability", { ...FINANCE, hasWrites: false, limit: 6 }],
		[
			"a category and a health status",
			{ ...FINANCE, healthStatus: "healthy", limit: 6 },
		],
		[
			"recently added healthy apps",
			{
				healthStatus: "healthy",
				hideShadowedVariants: true,
				sortBy: "sourceCreatedAt",
				limit: 24,
			},
		],
		[
			"a category by date",
			{ ...FINANCE, sortBy: "sourceCreatedAt", limit: 24, offset: 24 },
		],
	])("returns the same apps and total for %s", async (_name, options) => {
		const { sqlite, db } = catalog;
		const result = await listCatalogApps(db, options);
		const reference = expected(sqlite, options);
		expect(result.total).toBe(reference.total);
		expect(result.apps.map((app) => app.id)).toEqual(reference.ids);
		// Nothing a visitor may not see is ever on a page.
		for (const app of result.apps)
			expect(app).toMatchObject({
				isDiscoverable: true,
				status: "ENABLED",
				reviewStatus: "RELEASED",
			});
	});
});

describe.each([
	{ statistics: "no statistics", productionLike: false },
	{ statistics: "collected statistics", productionLike: true },
])("catalog query plans with $statistics", ({ productionLike }) => {
	let catalog: ReturnType<typeof fixture>;
	beforeAll(() => {
		catalog = fixture(productionLike);
	});
	beforeEach(() => {
		catalog.queries.length = 0;
	});

	it("counts a category through its own index and walks names for the page", async () => {
		const { sqlite, db, queries } = catalog;
		for (const [options, nameIndex] of [
			[{ ...FINANCE, limit: 6 }, "app_catalog_explore_name_idx"],
			[
				{ ...FINANCE, limit: 24, sortDir: "desc" },
				"app_catalog_explore_name_idx",
			],
			[{ category: "FINANCE", limit: 6 }, "app_catalog_public_browse_name_idx"],
		] as const) {
			queries.length = 0;
			const { apps } = await listCatalogApps(db, options);
			expect(queries).toHaveLength(2);
			expect(explain(sqlite, queries[0]!)).toContain(
				"SEARCH app_catalog USING INDEX app_catalog_category_idx (category=?)",
			);
			const page = explain(sqlite, queries[1]!);
			expect(page).toBe(`SCAN app_catalog USING INDEX ${nameIndex}`);
			expect(page).not.toMatch(/TEMP B-TREE/);
			// How far the page walked into the name index: the public apps up to
			// its last name. Before, every discoverable app was read, twice.
			const last = apps.at(-1)!.name;
			const { walked } = sqlite
				.prepare(
					`SELECT count(*) AS walked FROM app_catalog WHERE ${PUBLIC} AND name ${"sortDir" in options ? ">=" : "<="} ?`,
				)
				.get(last) as { walked: number };
			expect(walked).toBeLessThan(options.limit * 4);
			expect(walked).toBeLessThan(APPS / 40);
		}
	});

	it("reads only the category for a page near its end or of a small category", async () => {
		const { sqlite, db, queries } = catalog;
		for (const options of [
			{ category: "DESIGN", limit: 6 },
			{ ...FINANCE, limit: 50, offset: 1_150 },
			{ ...FINANCE, hasWrites: false, limit: 6 },
			{ ...FINANCE, sortBy: "sourceCreatedAt", limit: 24 },
		] as const) {
			queries.length = 0;
			await listCatalogApps(db, options);
			expect(queries).toHaveLength(2);
			for (const query of queries) {
				const plan = explain(sqlite, query);
				expect(plan).toContain(
					"SEARCH app_catalog USING INDEX app_catalog_category_idx (category=?)",
				);
				expect(plan).not.toContain("app_catalog_is_discoverable_idx");
			}
		}
	});

	it("reads only one health status for a page filtered by it", async () => {
		const { sqlite, db, queries } = catalog;
		await listCatalogApps(db, {
			healthStatus: "healthy",
			hideShadowedVariants: true,
			sortBy: "sourceCreatedAt",
			limit: 24,
		});
		expect(queries).toHaveLength(2);
		for (const query of queries)
			expect(explain(sqlite, query)).toContain(
				"SEARCH app_catalog USING INDEX app_catalog_health_status_idx (health_status=?)",
			);
	});

	it("does not read a page that has no apps", async () => {
		const { db, queries } = catalog;
		expect(await listCatalogApps(db, { category: "FOOD", limit: 6 })).toEqual({
			apps: [],
			total: 0,
		});
		expect(
			await listCatalogApps(db, { ...FINANCE, limit: 50, offset: 5_000 }),
		).toMatchObject({ apps: [] });
		expect(queries).toHaveLength(2);
		expect(queries.every((query) => query.includes("count(*)"))).toBe(true);
	});

	it("seeks the health status when counting lexical search matches", async () => {
		const { sqlite, db, queries } = catalog;
		const result = await listCatalogApps(db, {
			search: " APP 000 ",
			healthStatus: "healthy",
			hideShadowedVariants: true,
		});
		const reference = sqlite
			.prepare(`SELECT count(*) AS total FROM app_catalog
			WHERE ${PUBLIC} AND explore_shadowed = 0 AND health_status = 'healthy'
			AND LOWER(name) LIKE '%app 000%'`)
			.get();
		expect(result.total).toBe(reference!.total);
		expect(explain(sqlite, queries[0]!)).toContain(
			"SEARCH app_catalog USING INDEX app_catalog_health_status_idx (health_status=?)",
		);
	});

	it("seeks non-null endpoints for health inventory and backlog reads", async () => {
		const { sqlite, db, queries } = catalog;
		await getCatalogHealthSummary(db);
		expect(queries).toHaveLength(3);
		for (const query of queries)
			expect(explain(sqlite, query)).toContain(
				"SEARCH app_catalog USING INDEX app_catalog_mcp_endpoint_idx (mcp_endpoint_normalized>?)",
			);
	});

	it("leaves other search and operator lists to the planner", async () => {
		const { db, queries } = catalog;
		await listCatalogApps(db, { category: "FINANCE", search: "app 000" });
		await listCatalogApps(db, { category: "FINANCE", includeAll: true });
		await listCatalogApps(db, {
			healthStatus: "healthy",
			includeUnreleased: true,
		});
		expect(queries).toHaveLength(6);
		expect(queries.join("\n")).not.toContain("INDEXED BY");
	});
});
