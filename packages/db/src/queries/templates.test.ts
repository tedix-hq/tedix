import { DatabaseSync } from "node:sqlite";
import { getColumns, getTableName } from "drizzle-orm";
import { describe, expect, it } from "vite-plus/test";
import { ApplyTemplateInputSchema } from "@tedix/api-contract/contracts/templates";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { apps } from "../schema/apps";
import { appAdapters } from "../schema/adapters";
import { appTools } from "../schema/tools";
import { appTemplates } from "../schema/templates";
import { organizations } from "../schema/organizations";
import { applyTemplate } from "./templates";

describe("template extraction controls", () => {
	it("persists parsed context and controls through real template application", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			// Materialize the participating tables with their current columns; this test
			// exercises query serialization and D1 batch behavior, not schema constraints.
			for (const table of [
				apps,
				appAdapters,
				appTools,
				appTemplates,
				organizations,
			])
				sqlite.exec(
					`CREATE TABLE "${getTableName(table)}" (${Object.values(
						getColumns(table),
					)
						.map((column) => `"${column.name}" ${column.getSQLType()}`)
						.join(",")})`,
				);
			const db = createDbClient(createD1Facade(sqlite));
			const templateId = crypto.randomUUID(),
				organizationId = crypto.randomUUID();
			await db.insert(organizations).values({
				id: organizationId,
				name: "Example",
				slug: "example",
				appsCount: 0,
			});
			await db.insert(appTemplates).values({
				id: templateId,
				name: "Catalog",
				slug: "catalog",
				vertical: "ecommerce",
				isActive: true,
				extractionConfig: {
					method: "agent",
					arrayKey: "items",
					siteName: "{siteName}",
					siteSearchInstructions: "Browse",
					prompt: "Extract {siteContext}",
					schema: { type: "object" },
				},
				tools: [
					{
						toolId: "list_items",
						toolTypeId: "test",
						title: "Items",
						config: { context: "{siteContext}" },
						outputTemplate: "Catalog: {siteContext}",
					},
				],
			});
			const input = ApplyTemplateInputSchema.parse({
				templateId,
				organizationId,
				name: "Regional",
				slug: "regional",
				primaryDomain: "example.com",
				extractionConfigOverrides: {
					siteName: "Example",
					siteContext: "Regional catalog",
					agent: { maxCredits: 5 },
					quality: {
						rejectIncomplete: true,
						requiredFields: ["title"],
						logWarnings: false,
					},
				},
			});
			const result = await applyTemplate(db, templateId, input);
			expect(result.app.metadata?.extractionConfig).toMatchObject({
				siteName: "Example",
				siteContext: "Regional catalog",
				prompt: "Extract Regional catalog",
				agent: { maxCredits: 5 },
				quality: {
					rejectIncomplete: true,
					requiredFields: ["title"],
					logWarnings: false,
				},
			});
			expect(result.tools[0]?.config).toMatchObject({
				context: "Regional catalog",
			});
			expect(result.tools[0]?.outputTemplate).toBe("Catalog: Regional catalog");
		} finally {
			sqlite.close();
		}
	});
	it.each(["stored", "generic-override"])(
		"rejects invalid effective %s configuration before any write",
		async (source) => {
			const sqlite = new DatabaseSync(":memory:");
			try {
				for (const table of [
					apps,
					appAdapters,
					appTools,
					appTemplates,
					organizations,
				])
					sqlite.exec(
						`CREATE TABLE "${getTableName(table)}" (${Object.values(
							getColumns(table),
						)
							.map((column) => `"${column.name}" ${column.getSQLType()}`)
							.join(",")})`,
					);
				const db = createDbClient(createD1Facade(sqlite));
				const templateId = crypto.randomUUID(),
					organizationId = crypto.randomUUID();
				const supported = {
					method: "agent",
					arrayKey: "items",
					siteName: "Example",
					siteSearchInstructions: "Browse",
					prompt: "Extract",
					schema: { type: "object" },
				};
				const invalid = { ...supported, currency: "EUR" };
				await db.insert(organizations).values({
					id: organizationId,
					name: "Example",
					slug: "example",
					appsCount: 0,
				});
				await db.insert(appTemplates).values({
					id: templateId,
					name: "Catalog",
					slug: "catalog",
					vertical: "ecommerce",
					isActive: true,
				});
				if (source === "stored")
					sqlite
						.prepare(
							"UPDATE app_templates SET extraction_config = ? WHERE id = ?",
						)
						.run(JSON.stringify(invalid), templateId);
				const before = sqlite.prepare("SELECT total_changes() AS count").get();
				await expect(
					applyTemplate(db, templateId, {
						organizationId,
						name: "Example",
						slug: "example",
						primaryDomain: "example.com",
						metadataOverrides:
							source === "generic-override"
								? { extractionConfig: invalid }
								: undefined,
						extractionConfigOverrides: { siteContext: "Valid override" },
					}),
				).rejects.toThrow();
				expect(sqlite.prepare("SELECT total_changes() AS count").get()).toEqual(
					before,
				);
				expect(
					sqlite.prepare("SELECT COUNT(*) AS count FROM apps").get(),
				).toEqual({ count: 0 });
				expect(
					sqlite
						.prepare(
							"SELECT apps_count AS count FROM organizations WHERE id = ?",
						)
						.get(organizationId),
				).toEqual({ count: 0 });
			} finally {
				sqlite.close();
			}
		},
	);
});
