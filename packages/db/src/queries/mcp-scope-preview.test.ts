import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { apps } from "../schema/apps";
import { organizations } from "../schema/organizations";
import { appTools } from "../schema/tools";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { listPreviewSourceAppsBySlugs } from "./apps";
import { listToolsForScopePreviewByAppIds } from "./tools";

describe("MCP scope preview bulk reads on D1", () => {
	it("returns duplicate slugs with owning identities and narrow tool rows", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF");
		for (const table of [organizations, apps, appTools]) {
			sqlite.exec(schemaDdl(table));
		}
		const db = createDbClient(createD1Facade(sqlite));
		await db.insert(organizations).values([
			{ id: "own-org", name: "Own", slug: "own" },
			{
				id: "tedix-org",
				name: "Tedix",
				slug: "tedix",
				descopeTenantId: "org_tedix",
			},
		]);
		await db.insert(apps).values([
			{
				id: "own-app",
				organizationId: "own-org",
				name: "Shared own",
				slug: "shared",
				metadata: { mcpConfig: { aggregateApps: [] } },
			},
			{
				id: "tedix-app",
				organizationId: "tedix-org",
				name: "Shared cloud",
				slug: "shared",
			},
		]);
		await db.insert(appTools).values([
			{
				id: "own-tool",
				appId: "own-app",
				toolId: "list_items",
				title: "List items",
				toolTypeId: "rpc",
				sortOrder: 1,
				createdAt: "2026-09-29T00:00:00.000Z",
				updatedAt: "2026-09-29T00:00:00.000Z",
			},
			{
				id: "cloud-tool",
				appId: "tedix-app",
				toolId: "get_status",
				title: "Get status",
				toolTypeId: "rpc",
				sortOrder: 2,
				createdAt: "2026-09-29T00:00:00.000Z",
				updatedAt: "2026-09-29T00:00:00.000Z",
			},
		]);

		const sources = await listPreviewSourceAppsBySlugs(db, ["shared"]);
		expect(sources).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					id: "own-app",
					sourceOrgSlug: "own",
				}),
				expect.objectContaining({
					id: "tedix-app",
					sourceOrgTenantId: "org_tedix",
				}),
			]),
		);
		expect(sources).toHaveLength(2);

		const toolRows = await listToolsForScopePreviewByAppIds(db, [
			"own-app",
			"tedix-app",
			...Array.from({ length: 10 }, (_, index) => `empty-${index}`),
		]);
		expect(toolRows.map(({ id, appId }) => ({ id, appId }))).toEqual([
			{ id: "own-tool", appId: "own-app" },
			{ id: "cloud-tool", appId: "tedix-app" },
		]);
	});
});
