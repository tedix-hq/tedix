import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { and, eq } from "drizzle-orm";
import { tenantToolPolicyResourceGenerations } from "../schema/tenant-tool-policy";
import { batchNonEmpty } from "../utils/batch";
import { coreTable } from "../core-store/client";
import { createPGliteFacade } from "../test/pglite-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { organizations } from "../schema/organizations";
import { appCatalog } from "../schema/catalog";
import { describe, expect, it, vi } from "vite-plus/test";
import { createDbClient } from "../client";
import { apps } from "../schema/apps";
import { appTools } from "../schema/tools";
import { createD1Facade } from "../test/d1-facade";

import {
	inferCatalogToolOutputSchemas,
	deleteTool,
	bulkUpdateToolSortOrders,
	recordToolContractHashes,
	refreshToolSchemaProvenance,
	listToolsForScopePreviewByAppIds,
	listConnectionToolPoliciesByAppIds,
	listToolsForSchemaSyncScoped,
	listComposerToolsForOrganization,
	listToolsPage,
	findWorkspaceConnectionTool,
} from "./tools";

async function fixture(store: "d1" | "postgres") {
	const fixture =
		store === "d1"
			? (() => {
					const sqlite = createMigratedSqlite();
					return {
						db: createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 })),
						close: () => sqlite.close(),
						engine: undefined,
					};
				})()
			: await createPGliteFacade();
	if (fixture.engine)
		for (const migration of readMigrationFiles({
			migrationsFolder: fileURLToPath(
				new URL("../../drizzle-pg", import.meta.url),
			),
		}))
			for (const ddl of migration.sql) await fixture.engine.exec(ddl);
	const db = fixture.db;
	await db
		.insert(coreTable(db, organizations))
		.values({ id: "org-example", name: "Example", slug: "example" });
	await db.insert(coreTable(db, appCatalog)).values({
		id: "catalog",
		name: "Catalog",
		connectorType: "MCP",
		lastSyncedAt: "2026-11-25T00:00:00.000Z",
	});
	await db.insert(coreTable(db, apps)).values({
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
		db.insert(coreTable(db, appTools)).values({
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
	return { close: fixture.close, db, insert };
}

describe.each(["d1", "postgres"] as const)(
	"sampled output schemas: %s",
	(store) => {
		it("merges two samples, makes absent fields optional, and stores no sample values", async () => {
			const { close, db, insert } = await fixture(store);
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
				const [row] = await db.select().from(coreTable(db, appTools));
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
				await close();
			}
		});
		it("never evaluates a sample for sensitive rows or declared schemas", async () => {
			const { close, db, insert } = await fixture(store);
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
					(await db.select().from(coreTable(db, appTools))).map(
						(row) => row.outputSchema,
					),
				).toEqual([null, { type: "string" }]);
			} finally {
				await close();
			}
		});
		it("updates many installations once, keeps stale or newly sensitive rows, and runs policy triggers", async () => {
			const { close, db, insert } = await fixture(store);
			const tools = coreTable(db, appTools);
			const generations = coreTable(db, tenantToolPolicyResourceGenerations);
			try {
				await insert("sampled");
				const ids = Array.from({ length: 120 }, (_, i) => `installed-${i}`);
				await db.batch(
					batchNonEmpty(
						ids.map((id) =>
							db.insert(coreTable(db, apps)).values({
								id,
								organizationId: "org-example",
								name: id,
								slug: id,
								catalogAppId: "catalog",
							}),
						),
					),
				);
				for (const id of ids) await insert(`tool-${id}`, { appId: id });
				const write = vi.spyOn(db, "with");
				expect(
					await inferCatalogToolOutputSchemas(
						db,
						"catalog",
						"list_records",
						() => ({ count: 1 }),
					),
				).toBe(121);
				expect(write).toHaveBeenCalledTimes(1);
				write.mockRestore();
				const generation = () =>
					db
						.select({ generation: generations.generation })
						.from(generations)
						.where(
							and(
								eq(generations.resourceId, "sampled"),
								eq(generations.resourceKind, "tool"),
							),
						);
				expect(await generation()).toEqual([{ generation: 2 }]);
				const withCte = db.with.bind(db);
				const race = vi.spyOn(db, "with").mockImplementationOnce((...ctes) => {
					const scope = withCte(...ctes);
					const update = scope.update.bind(scope);
					vi.spyOn(scope, "update").mockImplementationOnce((table) => {
						const builder = update(table);
						const set = builder.set.bind(builder);
						vi.spyOn(builder, "set").mockImplementationOnce((values) => {
							const statement = set(values);
							const execute = statement.execute.bind(statement);
							vi.spyOn(statement, "execute").mockImplementationOnce(
								async () => {
									await db
										.update(tools)
										.set({ sensitiveData: true })
										.where(eq(tools.id, "sampled"));
									await db
										.update(tools)
										.set({ outputSchema: { type: "string" } })
										.where(eq(tools.id, "tool-installed-0"));
									return execute();
								},
							);
							return statement;
						});
						return builder;
					});
					return scope;
				});
				expect(
					await inferCatalogToolOutputSchemas(
						db,
						"catalog",
						"list_records",
						() => ({ next: true }),
					),
				).toBe(119);
				race.mockRestore();
				expect(
					(
						await db
							.select()
							.from(tools)
							.where(eq(tools.id, "tool-installed-0"))
					)[0]?.outputSchema,
				).toEqual({ type: "string" });
				expect(await generation()).toEqual([{ generation: 3 }]);
				await deleteTool(db, "sampled");
				expect(await generation()).toEqual([{ generation: 4 }]);
			} finally {
				vi.restoreAllMocks();
				await close();
			}
		});

		it("uses one candidate-set read and one batch for each bulk writer", async () => {
			const { close, db, insert } = await fixture(store);
			try {
				await insert("sampled", {
					config: {
						composer: true,
						auth: { type: "connection", connectionId: "conn" },
						transport: "mcp",
						endpoint: "records/list",
					},
				});
				const candidates = [
					...Array.from({ length: 300 }, (_, i) => `missing-${i}`),
					"installed",
					"installed",
				];
				const select = vi.spyOn(db, "select");
				expect(
					await listToolsForScopePreviewByAppIds(db, candidates),
				).toMatchObject([{ id: "sampled" }]);
				expect(select).toHaveBeenCalledTimes(1);
				select.mockClear();
				expect(
					await listConnectionToolPoliciesByAppIds(db, candidates),
				).toMatchObject([{ authType: "connection", connectionId: "conn" }]);
				expect(select).toHaveBeenCalledTimes(1);
				select.mockClear();
				expect(
					await listToolsForSchemaSyncScoped(db, "installed", {
						toolIds: ["list_records"],
						endpoints: [...candidates, "records/list"],
					}),
				).toMatchObject([{ id: "sampled" }]);
				expect(select).toHaveBeenCalledTimes(1);
				select.mockRestore();
				expect(
					await listComposerToolsForOrganization(db, "org-example"),
				).toMatchObject([{ toolId: "list_records" }]);
				expect(
					await listToolsPage(db, "installed", { limit: 10, offset: 0 }),
				).toMatchObject({ total: 1, inventoryTotal: 1 });
				expect(
					await listToolsPage(db, "installed", {
						limit: 10,
						offset: 0,
						query: "records",
					}),
				).toMatchObject({ total: 1 });
				await db
					.update(coreTable(db, apps))
					.set({
						metadata: {
							mcpConfig: {
								connectionProviderId: "provider",
								connectionInstanceId: "conn",
								connectionScope: "tenant",
							},
						},
					})
					.where(eq(coreTable(db, apps).id, "installed"));
				expect(
					await findWorkspaceConnectionTool(db, {
						organizationId: "org-example",
						toolName: "list_records",
						providerId: "provider",
						connectionInstanceId: "conn",
						connectionScope: "tenant",
					}),
				).toEqual({ appId: "installed", toolId: "list_records" });
				await insert("numeric-composer", {
					toolId: "numeric",
					config: { composer: 1 },
				});
				await insert("string-composer", {
					toolId: "string",
					config: { composer: "true" },
				});
				expect(
					await listComposerToolsForOrganization(db, "org-example"),
				).toHaveLength(1);
				const batch = vi.spyOn(db, "batch");
				await bulkUpdateToolSortOrders(db, [
					{ toolId: "sampled", sortOrder: 9 },
				]);
				expect(batch).toHaveBeenCalledTimes(1);
				batch.mockClear();
				await recordToolContractHashes(db, [
					{ id: "sampled", contractHash: "hash" },
				]);
				expect(batch).toHaveBeenCalledTimes(1);
				batch.mockClear();
				await refreshToolSchemaProvenance(db, {
					touchIds: candidates.concat("sampled"),
					certify: [
						{ id: "sampled", schemaSourceRef: "ref", schemaSourceHash: "hash" },
					],
					now: "2026-11-25T00:00:00.000Z",
				});
				expect(batch).toHaveBeenCalledTimes(1);
			} finally {
				vi.restoreAllMocks();
				await close();
			}
		});
	},
);
