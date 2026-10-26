import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { apps } from "../schema/apps";
import { appTools } from "../schema/tools";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { listComposerToolsForOrganization } from "./tools";

it("offers only enabled, explicit composer tools from this tenant", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(schemaDdl(apps, appTools));
		const db = createDbClient(createD1Facade(sqlite));
		for (const [id, organizationId, visibility] of [
			["sample", "org-one", "public"],
			["foreign", "org-two", "public"],
			["disabled", "org-one", "disabled"],
		] as const) {
			await db
				.insert(apps)
				.values({ id, organizationId, visibility, name: id, slug: id });
		}
		for (const row of [
			{ id: "write", appId: "sample", config: { composer: true } },
			{ id: "unmarked", appId: "sample", config: {} },
			{ id: "false", appId: "sample", config: { composer: false } },
			{ id: "string", appId: "sample", config: { composer: "true" } },
			{
				id: "off",
				appId: "sample",
				config: { composer: true },
				enabled: false,
			},
			{
				id: "private",
				appId: "sample",
				config: { composer: true },
				visibility: "private",
			},
			{ id: "foreign", appId: "foreign", config: { composer: true } },
			{ id: "disabled", appId: "disabled", config: { composer: true } },
		]) {
			await db.insert(appTools).values({
				toolId: row.id === "write" ? "send_message" : row.id,
				title: "Send",
				toolTypeId: "rpc",
				visibility: "public",
				...row,
			});
		}
		expect(await listComposerToolsForOrganization(db, "org-one")).toEqual([
			{
				appSlug: "sample",
				toolId: "send_message",
				title: "Send",
				description: null,
			},
		]);
	} finally {
		sqlite.close();
	}
});
