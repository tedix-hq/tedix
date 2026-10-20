import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { apps } from "../schema/apps";
import { appTools } from "../schema/tools";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { listSetupToolsForOrganization } from "./tools";

describe("setup tool inventory", () => {
	it("reads tools across every tenant app, including disabled ones, without foreign tools", async () => {
		const sqlite = new DatabaseSync(":memory:");
		sqlite.exec("PRAGMA foreign_keys = OFF");
		sqlite.exec(schemaDdl(apps, appTools));
		const db = createDbClient(createD1Facade(sqlite));
		for (let i = 0; i < 55; i++) {
			await db.insert(apps).values({
				id: `app-${i}`,
				organizationId: i === 54 ? "other-org" : "org-one",
				name: `App ${i}`,
				slug: `app-${i}`,
			});
			await db.insert(appTools).values({
				id: `tool-${i}`,
				appId: `app-${i}`,
				toolId: "read_data",
				title: "Read data",
				toolTypeId: "rpc",
				enabled: i !== 53,
				config: { auth: { type: "connection", connectionId: "data" } },
			});
		}
		const rows = await listSetupToolsForOrganization(db, "org-one");
		expect(rows).toHaveLength(54);
		expect(rows.some((r) => r.id === "tool-54")).toBe(false);
		expect(rows.find((r) => r.id === "tool-53")?.enabled).toBe(false);
		expect(rows[0]?.config).toEqual({
			auth: { type: "connection", connectionId: "data" },
		});
		sqlite.close();
	});
});
