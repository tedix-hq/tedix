// @ts-nocheck - package test type dependencies are not part of the db tsconfig.
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { getCatalogAppById, updateCatalogApp } from "./get-app";
import { getCatalogStoreListings } from "./store-listings";
import {
	disableOrphanedCatalogApps,
	markStoreListingsAsRemoved,
} from "./sync-logs";
import { syncCatalogAppFromStore } from "./upsert-sync";

function migratedDb(): DbClient {
	const sqlite = createMigratedSqlite({
		transformMigration: (sql) => sql.replaceAll("--> statement-breakpoint", ""),
	});
	return createDbClient(createD1Facade(sqlite));
}

// Fictional listing; a removal request names the person in `developer`.
const listing = {
	source: "chatgpt",
	sourceAppId: "asdk_app_fictional_0001",
	name: "Example Listing",
	connectorType: "MCP",
	baseUrl: "https://mcp.example.test/mcp",
	website: "https://example.test",
	developer: "Jane Example",
	description: "A fictional listing.",
	rawData: { developerName: "Jane Example" },
	reviewStatus: "RELEASED",
} as const;

describe("catalog removal-request suppression", () => {
	let db: DbClient;
	beforeEach(() => {
		db = migratedDb();
	});

	it("scrubs personal fields from the app and its store listings", async () => {
		const seeded = await syncCatalogAppFromStore(db, listing);
		const id = seeded.app.id;

		const updated = await updateCatalogApp(db, id, { status: "SUPPRESSED" });

		expect(updated.status).toBe("SUPPRESSED");
		expect(updated.isDiscoverable).toBe(false);
		expect(updated.developer).toBeNull();
		expect(updated.website).toBeNull();
		expect(updated.rawData).toBeNull();
		const [storeListing] = await getCatalogStoreListings(db, id);
		expect(storeListing.rawData).toBeNull();
		expect(storeListing.storeDescription).toBeNull();
	});

	it("does not refresh or re-enable a suppressed entry on a store sync", async () => {
		const seeded = await syncCatalogAppFromStore(db, listing);
		const id = seeded.app.id;
		await updateCatalogApp(db, id, { status: "SUPPRESSED" });

		const resynced = await syncCatalogAppFromStore(db, listing);
		// Matched by store source id even when the endpoint changed upstream.
		const moved = await syncCatalogAppFromStore(db, {
			...listing,
			baseUrl: "https://mcp.example.test/v2/mcp",
		});

		expect(resynced).toBeNull();
		expect(moved).toBeNull();
		const after = await getCatalogAppById(db, id);
		expect(after.status).toBe("SUPPRESSED");
		expect(after.developer).toBeNull();
		const [storeListing] = await getCatalogStoreListings(db, id);
		expect(storeListing.rawData).toBeNull();
	});

	it("keeps the suppressed listing when a registry sync no longer sees it", async () => {
		const seeded = await syncCatalogAppFromStore(db, listing);
		const id = seeded.app.id;
		await updateCatalogApp(db, id, { status: "SUPPRESSED" });
		await syncCatalogAppFromStore(db, {
			...listing,
			sourceAppId: "asdk_app_fictional_0002",
			name: "Other Listing",
			baseUrl: "https://mcp.other.test/mcp",
			website: "https://other.test",
			developer: "Other Co",
		});

		expect(
			await markStoreListingsAsRemoved(db, "chatgpt", [
				"asdk_app_fictional_0002",
			]),
		).toBe(0);
		await disableOrphanedCatalogApps(db);

		expect(await getCatalogStoreListings(db, id)).toHaveLength(1);
		expect((await getCatalogAppById(db, id)).status).toBe("SUPPRESSED");
		expect(await syncCatalogAppFromStore(db, listing)).toBeNull();
	});
});
