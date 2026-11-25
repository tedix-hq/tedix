import { expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { createMigratedSqlite } from "../../test/migrated-sqlite";
import { listPublicChatgptObservations } from "./list-apps";

it("publishes native listing evidence for a disabled connector while respecting removals and private listings", async () => {
	const sqlite = createMigratedSqlite({ foreignKeys: false });
	const db = createDbClient(createD1Facade(sqlite));
	const app = sqlite.prepare(`INSERT INTO app_catalog
		(id, name, connector_type, developer_type, is_discoverable, status, review_status, last_synced_at)
		VALUES (?, 'Shared connector', 'MCP', 'THIRD_PARTY', 0, ?, 'RELEASED', '2026-01-01')`);
	app.run("shared", "DISABLED");
	app.run("removed", "SUPPRESSED");
	const listing = sqlite.prepare(`INSERT INTO app_catalog_store_listings
		(id, catalog_app_id, source, source_app_id, store_url, review_status, last_synced_at, raw_data)
		VALUES (?, ?, 'chatgpt', ?, ?, 'RELEASED', '2026-01-01', ?)`);
	for (const [id, appId, visibility] of [
		["mail", "shared", "public"],
		["calendar", "shared", "public"],
		["removed", "removed", "public"],
		["private", "shared", "private"],
	] as const) {
		listing.run(
			id,
			appId,
			id,
			"https://chatgpt.com/apps/" + id,
			JSON.stringify({
				feed: {
					visibility,
					searchObservation: {
						name: id,
						checkedAt: "2026-01-01T00:00:00Z",
						matchedCount: 1,
						queryCount: 10,
					},
				},
			}),
		);
	}
	const rows = await listPublicChatgptObservations(db, 0, 10);
	expect(
		rows.map((row) => [row.sourceAppId, row.name, row.slug, row.storeUrl]),
	).toEqual([
		["calendar", "calendar", null, "https://chatgpt.com/apps/calendar"],
		["mail", "mail", null, "https://chatgpt.com/apps/mail"],
	]);
	sqlite.close();
});
