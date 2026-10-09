import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../../client";
import {
	appCatalog,
	appCatalogMcpTools,
	appCatalogStoreListings,
} from "../../schema/catalog";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	extractVendorDomain,
	normalizeVendorName,
} from "./endpoint-normalization";
import { listCatalogApps } from "./list-apps";
import {
	catalogVendorKeySql,
	listCatalogVendorVariants,
	refreshCatalogShadowedVariants,
} from "./vendor-variants";

type Row = {
	id: string;
	name: string;
	website: string | null;
	connector: string;
	endpoint?: string | null;
	tools?: number;
	discoverable?: boolean;
};

// Fictional vendors only.
const ROWS: Row[] = [
	// Acme Mail: runnable official row + listing-only and brokered siblings.
	{
		id: "acme-mcp",
		name: "Acme Mail",
		website: "https://acmemail.example",
		connector: "MCP",
		endpoint: "https://mcp.acmemail.example/mcp",
		tools: 4,
	},
	{
		id: "acme-listing",
		name: "Acme  mail",
		website: "https://www.acmemail.example/apps",
		connector: "FIRST_PARTY_ECOSYSTEM",
	},
	{
		id: "acme-service",
		name: "ACME MAIL",
		website: "acmemail.example",
		connector: "SERVICE",
	},
	// Same name, different domain: a different company with no runnable row.
	{
		id: "acme-other-co",
		name: "Acme Mail",
		website: "https://acme-mail.example",
		connector: "SERVICE",
	},
	// Listing-only vendor with no runnable sibling at all.
	{
		id: "lonely-listing",
		name: "Lonely Calendar",
		website: "https://lonelycal.example",
		connector: "FIRST_PARTY_ECOSYSTEM",
	},
	// Runnable sibling exists but is not publicly visible.
	{
		id: "hidden-runnable",
		name: "Shy Notes",
		website: "https://shynotes.example",
		connector: "MCP",
		endpoint: "https://shynotes.example/mcp",
		discoverable: false,
	},
	{
		id: "shy-listing",
		name: "Shy Notes",
		website: "https://shynotes.example",
		connector: "FIRST_PARTY_ECOSYSTEM",
	},
	// Two runnable per-store endpoints; only one has discovered tools.
	{
		id: "duo-stocked",
		name: "Duo Desk",
		website: "https://duodesk.example",
		connector: "MCP",
		endpoint: "https://mcp.duodesk.example/anthropic",
		tools: 5,
	},
	{
		id: "duo-empty",
		name: "Duo Desk",
		website: "https://duodesk.example",
		connector: "MCP",
		endpoint: "https://mcp.duodesk.example/openai",
	},
	// Two stocked per-store endpoints: one card, the plain slug.
	{
		id: "twin-ride",
		name: "Twin Ride",
		website: "https://twinride.example",
		connector: "MCP",
		endpoint: "https://mcp.twinride.example/mcp",
		tools: 2,
	},
	{
		id: "twin-ride-2",
		name: "Twin Ride",
		website: "https://twinride.example",
		connector: "MCP",
		endpoint: "https://mcp.twinride.example/claude/mcp",
		tools: 3,
	},
	// Two runnable endpoints, neither scanned yet: both stay.
	{
		id: "bare-a",
		name: "Bare Board",
		website: "https://bareboard.example",
		connector: "MCP",
		endpoint: "https://bareboard.example/a",
	},
	{
		id: "bare-b",
		name: "Bare Board",
		website: "https://bareboard.example",
		connector: "MCP",
		endpoint: "https://bareboard.example/b",
	},
];

function seededSqlite(): { sqlite: DatabaseSync; db: DbClient } {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		schemaDdl(appCatalog, appCatalogStoreListings, appCatalogMcpTools),
	);
	const insert = sqlite.prepare(
		`INSERT INTO app_catalog (id, slug, name, website, connector_type, mcp_endpoint_normalized, mcp_tool_count, developer_type, is_discoverable, status, review_status, last_synced_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, 'THIRD_PARTY', ?, 'ENABLED', 'RELEASED', '2026-01-01T00:00:00Z')`,
	);
	for (const row of ROWS) {
		insert.run(
			row.id,
			row.id,
			row.name,
			row.website,
			row.connector,
			row.endpoint ?? null,
			row.tools ?? 0,
			row.discoverable === false ? 0 : 1,
		);
	}
	sqlite.exec(`
		INSERT INTO app_catalog_store_listings (id, catalog_app_id, source, source_app_id, last_synced_at) VALUES
			('sl-1', 'acme-mcp', 'official', 'a1', '2026-01-01T00:00:00Z'),
			('sl-2', 'acme-listing', 'chatgpt', 'a2', '2026-01-01T00:00:00Z'),
			('sl-3', 'acme-listing', 'claude', 'a3', '2026-01-01T00:00:00Z');
	`);
	return {
		sqlite,
		db: createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 })),
	};
}

/** A seeded catalog whose shadowed flags are already refreshed. */
async function seededDb(): Promise<DbClient> {
	const { db } = seededSqlite();
	await refreshCatalogShadowedVariants(db);
	return db;
}

function flaggedIds(sqlite: DatabaseSync): string[] {
	return sqlite
		.prepare(
			"SELECT id FROM app_catalog WHERE explore_shadowed = 1 ORDER BY id",
		)
		.all()
		.map((row) => String(row.id));
}

async function listedIds(
	db: DbClient,
	hide: boolean,
	options: { includeUnreleased?: boolean } = {},
): Promise<string[]> {
	const { apps, total } = await listCatalogApps(db, {
		hideShadowedVariants: hide,
		...options,
	});
	expect(total).toBe(apps.length);
	return apps.map((app) => app.id).sort();
}

describe("catalog vendor variants", () => {
	it("hides a non-runnable row, or a runnable row with no tools, only when a better same-vendor sibling is visible", async () => {
		const db = await seededDb();
		expect(await listedIds(db, true)).toEqual([
			"acme-mcp",
			"acme-other-co",
			"bare-a",
			"bare-b",
			"duo-stocked",
			"lonely-listing",
			"shy-listing",
			"twin-ride",
		]);
	});

	it("keeps every row when variants are requested", async () => {
		const db = await seededDb();
		expect(await listedIds(db, false)).toEqual(
			ROWS.filter((row) => row.discoverable !== false)
				.map((row) => row.id)
				.sort(),
		);
	});

	it("hides shadowed rows under search too", async () => {
		const { apps } = await listCatalogApps(await seededDb(), {
			search: "acme",
			hideShadowedVariants: true,
		});
		expect(apps.map((app) => app.id).sort()).toEqual([
			"acme-mcp",
			"acme-other-co",
		]);
	});

	it("returns same-vendor siblings, runnable first, with their primary store", async () => {
		const db = await seededDb();
		const variants = await listCatalogVendorVariants(db, "acme-listing");
		expect(variants.map((v) => [v.id, v.runnable, v.primarySource])).toEqual([
			["acme-mcp", true, "official"],
			["acme-service", false, null],
		]);
		const fromRunnable = await listCatalogVendorVariants(db, "acme-mcp");
		expect(fromRunnable.map((v) => v.id).sort()).toEqual([
			"acme-listing",
			"acme-service",
		]);
		expect(await listCatalogVendorVariants(db, "acme-other-co")).toEqual([]);
		expect(await listCatalogVendorVariants(db, "missing")).toEqual([]);
	});

	it("flags exactly the rows the live window condition hides", async () => {
		const { sqlite, db } = seededSqlite();
		expect(flaggedIds(sqlite)).toEqual([]);
		// The admin path still evaluates the window subquery live; with every
		// fixture row RELEASED its visibility equals the public one.
		const liveVisible = await listedIds(db, true, { includeUnreleased: true });
		expect(await refreshCatalogShadowedVariants(db)).toEqual({
			flagged: 4,
			cleared: 0,
		});
		expect(flaggedIds(sqlite)).toEqual([
			"acme-listing",
			"acme-service",
			"duo-empty",
			"twin-ride-2",
		]);
		expect(await listedIds(db, true)).toEqual(liveVisible);
	});

	it("is idempotent", async () => {
		const { sqlite, db } = seededSqlite();
		await refreshCatalogShadowedVariants(db);
		const before = flaggedIds(sqlite);
		expect(await refreshCatalogShadowedVariants(db)).toEqual({
			flagged: 0,
			cleared: 0,
		});
		expect(flaggedIds(sqlite)).toEqual(before);
	});

	it("clears a flag when the shadowing sibling disappears", async () => {
		const { sqlite, db } = seededSqlite();
		await refreshCatalogShadowedVariants(db);
		sqlite.exec(
			"UPDATE app_catalog SET is_discoverable = 0 WHERE id = 'acme-mcp'",
		);
		expect(await refreshCatalogShadowedVariants(db)).toEqual({
			flagged: 0,
			cleared: 2,
		});
		expect(flaggedIds(sqlite)).toEqual(["duo-empty", "twin-ride-2"]);
		expect(await listedIds(db, true)).toContain("acme-listing");
	});

	it("hides flagged rows by default and shows them with variants", async () => {
		const { sqlite, db } = seededSqlite();
		sqlite.exec(
			"UPDATE app_catalog SET explore_shadowed = 1 WHERE id = 'lonely-listing'",
		);
		expect(await listedIds(db, true)).not.toContain("lonely-listing");
		expect(await listedIds(db, false)).toContain("lonely-listing");
	});

	it("computes the same vendor key in SQL as the TypeScript helpers", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec(schemaDdl(appCatalog));
		const samples: Array<[string, string | null]> = [
			["Acme Mail", "https://www.AcmeMail.example/path?x=1"],
			["  Acme\tMail ", "http://acmemail.example:8443"],
			["Acme Mail", "acmemail.example#top"],
			["Acme", "WWW.acme.example"],
			["Acme", null],
			["", "https://acme.example"],
		];
		const insert = sqlite.prepare(
			"INSERT INTO app_catalog (id, name, website, connector_type, last_synced_at) VALUES (?, ?, ?, 'MCP', '2026-01-01T00:00:00Z')",
		);
		samples.forEach(([name, website], index) => {
			insert.run(`k-${index}`, name, website);
		});
		const db = createDbClient(createD1Facade(sqlite));
		const rows = await db
			.select({
				id: appCatalog.id,
				vendorKey: catalogVendorKeySql(appCatalog).as("vendor_key"),
			})
			.from(appCatalog)
			.orderBy(appCatalog.id);
		const expected = samples.map(([name, website]) => {
			const domain = extractVendorDomain(website);
			const normalized = normalizeVendorName(name);
			return domain && normalized ? `${domain}|${normalized}` : null;
		});
		expect(rows.map((row) => row.vendorKey)).toEqual(expected);
	});
});
