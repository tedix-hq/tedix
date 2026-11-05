import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "../client";
import { apps } from "../schema/apps";
import { appTools } from "../schema/tools";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { inferCatalogToolOutputSchemas } from "./tools";

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(apps, appTools));
	const db = createDbClient(createD1Facade(sqlite));
	await db.insert(apps).values({
		id: "installed",
		organizationId: "org-example",
		name: "Installed",
		slug: "installed",
		catalogAppId: "catalog",
	});
	const insert = (
		id: string,
		extra: Partial<typeof appTools.$inferInsert> = {},
	) =>
		db.insert(appTools).values({
			id,
			appId: "installed",
			toolTypeId: "mcp",
			toolId: "list_records",
			title: "List records",
			config: {
				transport: "mcp",
				mcpServerId: "catalog",
				mcpToolName: extra.toolId ?? "list_records",
			},
			...extra,
		});
	return { sqlite, db, insert };
}

describe("sampled output schemas", () => {
	it("merges two samples, makes absent fields optional, and stores no sample values", async () => {
		const { sqlite, db, insert } = await fixture();
		try {
			await insert("sampled");
			await inferCatalogToolOutputSchemas(
				db,
				"catalog",
				"list_records",
				() => ({
					data: [{ id: "private-value", title: "First" }],
					cursor: null,
				}),
			);
			await inferCatalogToolOutputSchemas(
				db,
				"catalog",
				"list_records",
				() => ({ data: [{ id: "another-value", count: 2 }], cursor: "next" }),
			);
			const [row] = await db.select().from(appTools);
			expect(row?.outputSchema).toEqual({
				type: "object",
				"x-tedix-provenance": "inferred",
				required: ["data", "cursor"],
				properties: {
					data: {
						type: "array",
						items: {
							type: "object",
							properties: {
								id: { type: "string" },
								title: { type: "string" },
								count: { type: "number" },
							},
							required: ["id"],
						},
					},
					cursor: { anyOf: [{ type: "null" }, { type: "string" }] },
				},
			});
			expect(JSON.stringify(row?.outputSchema)).not.toMatch(
				/private-value|another-value|First|next/,
			);
		} finally {
			sqlite.close();
		}
	});
	it("never evaluates a sample for sensitive rows or declared schemas", async () => {
		const { sqlite, db, insert } = await fixture();
		try {
			await insert("sensitive", { sensitiveData: true });
			await insert("declared", {
				toolId: "get_record",
				outputSchema: { type: "string" },
			});
			const sample = vi.fn(() => {
				throw new Error("must not sample");
			});
			expect(
				await inferCatalogToolOutputSchemas(
					db,
					"catalog",
					"list_records",
					sample,
				),
			).toBe(0);
			expect(
				await inferCatalogToolOutputSchemas(
					db,
					"catalog",
					"get_record",
					sample,
				),
			).toBe(0);
			expect(
				await inferCatalogToolOutputSchemas(
					db,
					"other-catalog",
					"list_records",
					sample,
				),
			).toBe(0);
			expect(sample).not.toHaveBeenCalled();
			expect(
				(await db.select().from(appTools)).map((row) => row.outputSchema),
			).toEqual([null, { type: "string" }]);
		} finally {
			sqlite.close();
		}
	});
});
