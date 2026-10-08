import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import {
	appCatalogStoreListings,
	appCatalogSyncLogs,
} from "../../schema/catalog";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	ensureCatalogSnapshotSyncLog,
	markStaleFeedStoreListingsAsRemoved,
	markStoreListingsAsRemoved,
	SNAPSHOT_FEED_MARKER,
} from "./sync-logs";
function realDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(
		"CREATE TABLE app_catalog (id TEXT PRIMARY KEY); INSERT INTO app_catalog (id) VALUES ('app');",
	);
	sqlite.exec(schemaDdl(appCatalogSyncLogs));
	sqlite.exec(schemaDdl(appCatalogStoreListings));
	return createDbClient(createD1Facade(sqlite));
}
describe("catalog snapshot persistence", () => {
	it("does not overwrite the owner or completion of an existing snapshot", async () => {
		const db = realDb();
		const first = {
			id: "snapshot",
			syncType: "full",
			status: "completed",
			startedAt: "2026-09-19T00:00:00Z",
			details: { snapshotOwner: "owner", inputHash: "hash" },
		};
		await ensureCatalogSnapshotSyncLog(db, first);
		const replay = await ensureCatalogSnapshotSyncLog(db, {
			...first,
			status: "running",
			details: { snapshotOwner: "other", inputHash: "other" },
		});
		expect(replay.status).toBe("completed");
		expect(replay.details).toEqual(first.details);
	});
	it("removes only absent listings with matching feed object provenance", async () => {
		const db = realDb();
		await db.insert(appCatalogStoreListings).values([
			{
				id: "current",
				catalogAppId: "app",
				lastSyncedAt: "2026-09-19T00:00:00Z",
				source: "claude",
				sourceAppId: "current",
				rawData: { supplier: { id: "current" } },
			},
			{
				id: "stale",
				catalogAppId: "app",
				lastSyncedAt: "2026-09-19T00:00:00Z",
				source: "claude",
				sourceAppId: "stale",
				rawData: { supplier: { id: "stale" } },
			},
			{
				id: "official",
				catalogAppId: "app",
				lastSyncedAt: "2026-09-19T00:00:00Z",
				source: "claude",
				sourceAppId: "official",
				rawData: { registry: { id: "official" } },
			},
			{
				id: "other-store",
				catalogAppId: "app",
				lastSyncedAt: "2026-09-19T00:00:00Z",
				source: "chatgpt",
				sourceAppId: "stale",
				rawData: { supplier: { id: "stale" } },
			},
		]);
		expect(
			await markStaleFeedStoreListingsAsRemoved(db, "claude", "supplier", [
				"current",
			]),
		).toBe(1);
		expect(
			(await db.select().from(appCatalogStoreListings))
				.map((row) => row.id)
				.sort(),
		).toEqual(["current", "official", "other-store"]);
		expect(
			await markStaleFeedStoreListingsAsRemoved(db, "claude", "supplier", []),
		).toBe(0);
	});
	it("keeps a snapshot feed's listings out of a registry sync's removals", async () => {
		const db = realDb();
		await db.insert(appCatalogStoreListings).values([
			{
				id: "registry-current",
				catalogAppId: "app",
				lastSyncedAt: "2026-10-08T00:00:00Z",
				source: "claude",
				sourceAppId: "registry-current",
				rawData: { registry: { id: "registry-current" } },
			},
			{
				id: "registry-stale",
				catalogAppId: "app",
				lastSyncedAt: "2026-10-08T00:00:00Z",
				source: "claude",
				sourceAppId: "registry-stale",
				rawData: { registry: { id: "registry-stale" } },
			},
			{
				id: "feed-owned",
				catalogAppId: "app",
				lastSyncedAt: "2026-10-08T00:00:00Z",
				source: "claude",
				sourceAppId: "feed-owned",
				rawData: {
					supplier: { id: "feed-owned" },
					[SNAPSHOT_FEED_MARKER]: "supplier",
				},
			},
		]);
		expect(
			await markStoreListingsAsRemoved(db, "claude", ["registry-current"]),
		).toBe(1);
		expect(
			(await db.select().from(appCatalogStoreListings))
				.map((row) => row.id)
				.sort(),
		).toEqual(["feed-owned", "registry-current"]);
	});
});
