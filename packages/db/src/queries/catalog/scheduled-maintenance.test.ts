import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { createD1Facade } from "../../test/d1-facade";
import { listEnabledCatalogAppsForVectorSync } from "./scheduled-maintenance";

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
});
