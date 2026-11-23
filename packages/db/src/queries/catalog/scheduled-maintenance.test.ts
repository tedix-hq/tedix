import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { appCatalog, appCatalogStoreListings } from "../../schema/catalog";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	autoDelistStaleCatalogApps,
	autoDelistStaleCatalogAppsWithStats,
	autoHideUnhealthyCatalogApps,
	getStaleUnhealthyAppCount,
	listEnabledCatalogAppsForVectorSync,
} from "./scheduled-maintenance";
import { markCatalogListingsSeen } from "./store-listings";

function realDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(appCatalog, appCatalogStoreListings));
	return { db: createDbClient(createD1Facade(sqlite)), sqlite };
}

describe("unhealthy catalog lifecycle", () => {
	it("counts and hides only discoverable unhealthy apps with an old health check", async () => {
		const { db, sqlite } = realDb();
		const insert = sqlite.prepare(
			"INSERT INTO app_catalog (id, slug, name, connector_type, last_synced_at, health_status, is_discoverable, health_data) VALUES (?, ?, ?, 'MCP', '2000-01-01T00:00:00.000Z', ?, ?, ?)",
		);
		const old = JSON.stringify({ lastCheckedAt: "2000-01-01T00:00:00.000Z" });
		insert.run("old", "old", "Old", "unhealthy", 1, old);
		insert.run(
			"fresh",
			"fresh",
			"Fresh",
			"unhealthy",
			1,
			JSON.stringify({ lastCheckedAt: new Date().toISOString() }),
		);
		insert.run("healthy", "healthy", "Healthy", "healthy", 1, old);
		insert.run("hidden", "hidden", "Hidden", "unhealthy", 0, old);
		insert.run("unknown", "unknown", "Unknown", "unhealthy", 1, null);

		expect(await getStaleUnhealthyAppCount(db, 14)).toBe(1);
		expect(await autoHideUnhealthyCatalogApps(db, 30)).toBe(1);
		expect(await getStaleUnhealthyAppCount(db, 14)).toBe(0);
		expect(
			sqlite
				.prepare(
					"SELECT id FROM app_catalog WHERE is_discoverable = 1 ORDER BY id",
				)
				.all(),
		).toEqual([{ id: "fresh" }, { id: "healthy" }, { id: "unknown" }]);
	});
});

describe("listEnabledCatalogAppsForVectorSync", () => {
	it("returns deterministic bounded pages and excludes disabled apps", async () => {
		const { db, sqlite } = realDb();
		const insert = sqlite.prepare(
			"INSERT INTO app_catalog (id, slug, name, connector_type, status, last_synced_at) VALUES (?, ?, ?, 'MCP', ?, '2000-01-01T00:00:00.000Z')",
		);
		insert.run("c", "c", "C", "ENABLED");
		insert.run("a", "a", "A", "ENABLED");
		insert.run("b", "b", "B", "ENABLED");
		insert.run("disabled", "disabled", "Disabled", "DISABLED");

		const first = await listEnabledCatalogAppsForVectorSync(db, { limit: 2 });
		expect(first.map((app) => app.id)).toEqual(["a", "b"]);

		// A status change behind the cursor must not shift the next page.
		sqlite
			.prepare("UPDATE app_catalog SET status = 'DISABLED' WHERE id = 'a'")
			.run();
		const next = await listEnabledCatalogAppsForVectorSync(db, {
			limit: 2,
			afterId: first.at(-1)?.id,
		});
		expect(next.map((app) => app.id)).toEqual(["c"]);
	});

	it("returns only apps written since a given time when asked", async () => {
		const { db, sqlite } = realDb();
		const insert = sqlite.prepare(
			"INSERT INTO app_catalog (id, slug, name, connector_type, status, last_synced_at, updated_at) VALUES (?, ?, ?, 'MCP', 'ENABLED', '2000-01-01T00:00:00.000Z', ?)",
		);
		insert.run("old", "old", "Old", "2026-11-17 02:00:00");
		insert.run("new", "new", "New", "2026-11-18 02:10:00");

		const changed = await listEnabledCatalogAppsForVectorSync(db, {
			limit: 10,
			updatedSince: "2026-11-18 02:00:00",
		});
		expect(changed.map((app) => app.id)).toEqual(["new"]);
		const all = await listEnabledCatalogAppsForVectorSync(db, { limit: 10 });
		expect(all.map((app) => app.id)).toEqual(["new", "old"]);
	});
});

describe("markCatalogListingsSeen", () => {
	it("marks the named listings and their apps as seen without touching updatedAt", async () => {
		const { db, sqlite } = realDb();
		const app = sqlite.prepare(
			"INSERT INTO app_catalog (id, slug, name, connector_type, status, last_synced_at, updated_at) VALUES (?, ?, ?, 'MCP', 'ENABLED', '2000-01-01T00:00:00.000Z', '2026-11-01 00:00:00')",
		);
		app.run("seen-app", "seen-app", "Seen");
		app.run("other-app", "other-app", "Other");
		await db.insert(appCatalogStoreListings).values([
			{
				id: "l1",
				catalogAppId: "seen-app",
				lastSyncedAt: "2000-01-01T00:00:00.000Z",
				source: "chatgpt",
				sourceAppId: "one",
			},
			{
				id: "l2",
				catalogAppId: "other-app",
				lastSyncedAt: "2000-01-01T00:00:00.000Z",
				source: "chatgpt",
				sourceAppId: "two",
			},
			// Same store id in another store: must not be marked.
			{
				id: "l3",
				catalogAppId: "other-app",
				lastSyncedAt: "2000-01-01T00:00:00.000Z",
				source: "claude",
				sourceAppId: "one",
			},
		]);

		const seenAt = "2026-11-18T02:00:00.000Z";
		await markCatalogListingsSeen(
			db,
			[{ source: "chatgpt", sourceAppId: "one" }],
			seenAt,
		);

		const listings = sqlite
			.prepare(
				"SELECT id, last_synced_at AS seen FROM app_catalog_store_listings ORDER BY id",
			)
			.all();
		expect(listings).toEqual([
			{ id: "l1", seen: seenAt },
			{ id: "l2", seen: "2000-01-01T00:00:00.000Z" },
			{ id: "l3", seen: "2000-01-01T00:00:00.000Z" },
		]);
		const apps = sqlite
			.prepare(
				"SELECT id, last_synced_at AS seen, updated_at AS updated FROM app_catalog ORDER BY id",
			)
			.all();
		expect(apps).toEqual([
			{
				id: "other-app",
				seen: "2000-01-01T00:00:00.000Z",
				updated: "2026-11-01 00:00:00",
			},
			{ id: "seen-app", seen: seenAt, updated: "2026-11-01 00:00:00" },
		]);
	});

	it("handles more listings than one statement can bind", async () => {
		const { db, sqlite } = realDb();
		sqlite
			.prepare(
				"INSERT INTO app_catalog (id, slug, name, connector_type, status, last_synced_at) VALUES ('app', 'app', 'App', 'MCP', 'ENABLED', '2000-01-01T00:00:00.000Z')",
			)
			.run();
		const ids = Array.from({ length: 205 }, (_, index) => `id-${index}`);
		const listing = sqlite.prepare(
			"INSERT INTO app_catalog_store_listings (id, catalog_app_id, source, source_app_id, last_synced_at) VALUES (?, 'app', 'claude', ?, '2000-01-01T00:00:00.000Z')",
		);
		for (const sourceAppId of ids) listing.run(sourceAppId, sourceAppId);

		await markCatalogListingsSeen(
			db,
			ids.map((sourceAppId) => ({ source: "claude" as const, sourceAppId })),
			"2026-11-18T02:00:00.000Z",
		);

		const stale = sqlite
			.prepare(
				"SELECT COUNT(*) AS n FROM app_catalog_store_listings WHERE last_synced_at < '2026-01-01'",
			)
			.get();
		expect(stale).toEqual({ n: 0 });
	});
});

describe("autoDelistStaleCatalogApps", () => {
	const STALE = "2000-01-01T00:00:00.000Z";

	function insertApp(
		sqlite: DatabaseSync,
		app: {
			id: string;
			lastSyncedAt: string;
			status?: string;
			healthStatus?: string;
			authTypes?: string | null;
			scanAuthHeaders?: string | null;
			scanConnectionId?: string | null;
		},
	) {
		sqlite
			.prepare(
				`INSERT INTO app_catalog (
					id, slug, name, connector_type, status, last_synced_at,
					health_status, auth_types, scan_auth_headers, scan_connection_id
				) VALUES (?, ?, ?, 'MCP', ?, ?, ?, ?, ?, ?)`,
			)
			.run(
				app.id,
				app.id,
				app.id,
				app.status ?? "ENABLED",
				app.lastSyncedAt,
				app.healthStatus ?? "healthy",
				app.authTypes ?? null,
				app.scanAuthHeaders ?? null,
				app.scanConnectionId ?? null,
			);
	}

	function insertManualListing(sqlite: DatabaseSync, catalogAppId: string) {
		sqlite
			.prepare(
				`INSERT INTO app_catalog_store_listings
					(id, catalog_app_id, source, source_app_id, last_synced_at)
				VALUES (?, ?, 'manual', ?, ?)`,
			)
			.run(`listing-${catalogAppId}`, catalogAppId, catalogAppId, STALE);
	}

	function statusOf(sqlite: DatabaseSync, id: string): string {
		return sqlite
			.prepare("SELECT status FROM app_catalog WHERE id = ?")
			.get(id)!.status as string;
	}

	it("keeps stale manual and auth-gated apps enabled while delisting scanner-synced apps", async () => {
		const { db, sqlite } = realDb();
		const FRESH = new Date().toISOString();

		// Manually listed: the app never reappears in a store feed, so its
		// last_synced_at can only age — staleness cannot mean "gone".
		insertApp(sqlite, { id: "manual-stale", lastSyncedAt: STALE });
		insertManualListing(sqlite, "manual-stale");
		// Latest health is requires_auth: the scanner cannot log in, so it
		// cannot refresh the row.
		insertApp(sqlite, {
			id: "auth-stale",
			lastSyncedAt: STALE,
			healthStatus: "requires_auth",
		});
		// auth_types demands OAUTH and no scan credential is configured.
		insertApp(sqlite, {
			id: "oauth-stale",
			lastSyncedAt: STALE,
			authTypes: '["OAUTH"]',
		});
		// auth_types demands OAUTH but the scanner holds a vault credential.
		insertApp(sqlite, {
			id: "oauth-with-credential",
			lastSyncedAt: STALE,
			authTypes: '["OAUTH"]',
			scanConnectionId: "conn-1",
		});
		// Ordinary scanner-synced app with no auth requirement.
		insertApp(sqlite, {
			id: "none-stale",
			lastSyncedAt: STALE,
			authTypes: '["NONE"]',
		});
		// Fresh apps are untouched, protected or not.
		insertApp(sqlite, { id: "fresh-none", lastSyncedAt: FRESH });
		insertApp(sqlite, {
			id: "fresh-manual",
			lastSyncedAt: FRESH,
		});
		insertManualListing(sqlite, "fresh-manual");

		const result = await autoDelistStaleCatalogAppsWithStats(db, 21);

		expect(result).toEqual({ delisted: 2, skippedProtected: 3 });
		expect(statusOf(sqlite, "manual-stale")).toBe("ENABLED");
		expect(statusOf(sqlite, "auth-stale")).toBe("ENABLED");
		expect(statusOf(sqlite, "oauth-stale")).toBe("ENABLED");
		expect(statusOf(sqlite, "oauth-with-credential")).toBe("DELISTED");
		expect(statusOf(sqlite, "none-stale")).toBe("DELISTED");
		expect(statusOf(sqlite, "fresh-none")).toBe("ENABLED");
		expect(statusOf(sqlite, "fresh-manual")).toBe("ENABLED");
	});

	it("keeps the numeric result and delists an unprotected row with unknown health", async () => {
		const { db, sqlite } = realDb();
		insertApp(sqlite, { id: "unknown-health", lastSyncedAt: STALE });
		sqlite
			.prepare(
				"UPDATE app_catalog SET health_status = NULL WHERE id = 'unknown-health'",
			)
			.run();
		expect(await autoDelistStaleCatalogApps(db, 21)).toBe(1);
		expect(statusOf(sqlite, "unknown-health")).toBe("DELISTED");
	});

	it("delists every stale enabled app when the guards are switched off", async () => {
		const { db, sqlite } = realDb();
		insertApp(sqlite, { id: "manual-stale", lastSyncedAt: STALE });
		insertManualListing(sqlite, "manual-stale");
		insertApp(sqlite, {
			id: "auth-stale",
			lastSyncedAt: STALE,
			healthStatus: "requires_auth",
		});

		const result = await autoDelistStaleCatalogAppsWithStats(db, 21, {
			keepManual: false,
			keepAuthGated: false,
		});

		expect(result).toEqual({ delisted: 2, skippedProtected: 0 });
		expect(statusOf(sqlite, "manual-stale")).toBe("DELISTED");
		expect(statusOf(sqlite, "auth-stale")).toBe("DELISTED");
	});
});
