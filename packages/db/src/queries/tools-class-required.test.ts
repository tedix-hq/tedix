import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { apps } from "../schema/apps";
import { propagateTools } from "./catalog/fork-propagation";
import { appTools } from "../schema/tools";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { upsertTool } from "./tools";

const APP_ID = "5eed0020-0000-4000-8000-000000000020";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(apps, appTools));
	return createDbClient(createD1Facade(sqlite));
}

const base = {
	appId: APP_ID,
	toolTypeId: "rpc",
	title: "Tidy notes",
	config: { transport: "rpc", endpoint: "notes/tidy" },
};

describe("a new tool row states its class", () => {
	it("refuses copying a write without a tier into a fork", async () => {
		const db = setup();
		await db.insert(apps).values({
			id: APP_ID,
			organizationId: "example-org",
			name: "Source",
			slug: "source",
			primaryDomain: "source.example",
		});
		await db.insert(appTools).values({
			...base,
			id: "source-tool",
			toolId: "tidy_notes",
			writeCapability: "write",
		});
		await expect(
			propagateTools(db, {
				sourceAppId: APP_ID,
				appIds: ["target-app"],
				dryRun: false,
			}),
		).rejects.toThrow("has no risk tier");
		expect(await db.select().from(appTools)).toHaveLength(1);
	});

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

	it("saves a write with an explicit tier and a read with none", async () => {
		const db = setup();
		const write = await upsertTool(db, {
			...base,
			toolId: "tidy_notes",
			writeCapability: "write",
			meta: {
				"com.tedix/policy": {
					riskTier: "bounded_write",
					blastRadius: "single_resource",
				},
			},
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

	it("keeps an existing declaration on an unrelated update and refuses clearing it", async () => {
		const db = setup();
		const original = await upsertTool(db, {
			...base,
			toolId: "tidy_notes",
			writeCapability: "write",
			meta: {
				"com.tedix/policy": {
					riskTier: "bounded_write",
					blastRadius: "single_resource",
					declared: true,
				},
			},
		});
		const updated = await upsertTool(db, {
			...base,
			toolId: "tidy_notes",
			title: "Renamed",
		});
		expect(updated.meta).toEqual(original.meta);
		expect(updated.writeCapability).toBe("write");
		await expect(
			upsertTool(db, {
				...base,
				id: original.id,
				toolId: "tidy_notes",
				writeCapability: null,
			}),
		).rejects.toThrow("has no write class");
		await expect(
			upsertTool(db, { ...base, toolId: "tidy_notes", meta: null }),
		).rejects.toThrow("has no risk tier");
	});

	it("refuses a new or resubmitted write without a tier", async () => {
		const db = setup();
		await expect(
			upsertTool(db, {
				...base,
				toolId: "tidy_notes",
				writeCapability: "write",
			}),
		).rejects.toThrow("has no risk tier");
		await db
			.insert(appTools)
			.values({ ...base, id: "legacy", toolId: "legacy_tool" } as never);
		await expect(
			upsertTool(db, { ...base, toolId: "legacy_tool", title: "Renamed" }),
		).rejects.toThrow("has no write class");
	});
});
