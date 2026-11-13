import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { appTools } from "../schema/tools";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { upsertTool } from "./tools";

const APP_ID = "5eed0020-0000-4000-8000-000000000020";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(appTools));
	return createDbClient(createD1Facade(sqlite));
}

const base = {
	appId: APP_ID,
	toolTypeId: "rpc",
	title: "Tidy notes",
	config: { transport: "rpc", endpoint: "notes/tidy" },
};

describe("a new tool row states its class", () => {
	it("refuses a new tool with no write class", async () => {
		await expect(
			upsertTool(setup(), { ...base, toolId: "tidy_notes" }),
		).rejects.toThrow("Tool tidy_notes has no write class");
	});

	it("refuses a destructive tool stated as a bounded write", async () => {
		await expect(
			upsertTool(setup(), {
				...base,
				toolId: "tidy_notes",
				writeCapability: "destructive",
				meta: {
					"com.tedix/policy": {
						riskTier: "bounded_write",
						blastRadius: "single_resource",
					},
				},
			}),
		).rejects.toThrow("declared destructive");
	});

	it("saves a write with a derived tier and a read with none", async () => {
		const db = setup();
		const write = await upsertTool(db, {
			...base,
			toolId: "tidy_notes",
			writeCapability: "write",
		});
		expect(write.meta).toEqual({
			"com.tedix/policy": {
				riskTier: "bounded_write",
				blastRadius: "single_resource",
			},
		});
		const read = await upsertTool(db, {
			...base,
			toolId: "list_notes",
			writeCapability: "read",
		});
		expect(read.writeCapability).toBe("read");
	});

	it("still updates an older row that has no class", async () => {
		const db = setup();
		await db.insert(appTools).values({
			...base,
			id: "legacy",
			toolId: "legacy_tool",
		} as never);
		const updated = await upsertTool(db, {
			...base,
			toolId: "legacy_tool",
			title: "Renamed",
		});
		expect(updated.title).toBe("Renamed");
		expect(updated.writeCapability).toBeNull();
	});
});
