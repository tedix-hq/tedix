import { AsyncResource } from "node:async_hooks";
import { fileURLToPath } from "node:url";
import { createCoreStore } from "@tedix/db/core-store/client";
import { coreDb, withCoreStore } from "@tedix/db/core-store/scope";
import { getAppById, getAppMetadataJson } from "@tedix/db/queries/app-records";
import { getItemsByApp } from "@tedix/db/queries/items";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { createPGliteFacade } from "@tedix/db/test/pglite-facade";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { expect, it, vi } from "vite-plus/test";
import { ImportWorkflow } from "./import-workflow";

vi.mock("cloudflare:workflows", () => ({
	NonRetryableError: class extends Error {},
}));
vi.mock("@tedix/db/core-store/client", async (original) => ({
	...(await original<typeof import("@tedix/db/core-store/client")>()),
	createCoreStore: vi.fn(),
}));

it.each(["postgres", "d1"] as const)(
	"imports across detached Workflow step callbacks on %s",
	async (dialect) => {
		const engine = new AsyncResource("workflow-engine");
		const sqlite = dialect === "d1" ? createMigratedSqlite() : undefined;
		const pg = dialect === "postgres" ? await createPGliteFacade() : undefined;
		const close = vi.fn(async () => {});
		const execute = async (sql: string) => {
			if (pg) await pg.engine.exec(sql);
			else sqlite!.exec(sql);
		};
		try {
			if (pg) {
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../../packages/db/drizzle-pg", import.meta.url),
					),
				}))
					for (const sql of migration.sql) await execute(sql);
				vi.mocked(createCoreStore).mockReturnValue({ db: pg.db, close });
			}
			await execute(`INSERT INTO organizations (id,name,slug) VALUES ('org-example','Example','example');
INSERT INTO apps (id,organization_id,name,slug,metadata) VALUES ('app-example','org-example','Example','example','{}');`);
			const env = {
				CORE_STORE: dialect,
				DB: sqlite ? createD1Facade(sqlite) : undefined,
			} as CloudflareEnv;
			const workflow = new ImportWorkflow({} as never, env);
			const steps: string[] = [];
			const step = {
				do: async (
					name: string,
					_options: unknown,
					callback: () => Promise<unknown>,
				) => {
					steps.push(name);
					// Workflows invokes the callback over RPC without the run() async context.
					return engine.runInAsyncScope(async () => {
						if (pg)
							expect(() => coreDb(env)).toThrow(
								"requires a withCoreStore scope",
							);
						return callback();
					});
				},
			};
			await withCoreStore(env, async () => {
				const result = await workflow.run(
					{
						payload: {
							appId: "app-example",
							vertical: "ecommerce",
							arrayKey: "items",
							data: {
								items: [
									{ title: "Example item", sku: "sku-example", price: 10 },
								],
							},
						},
					} as never,
					step as never,
				);
				expect(result).toMatchObject({
					success: true,
					imported: 1,
					errors: [],
				});
				expect(await getItemsByApp(coreDb(env), "app-example")).toEqual([
					expect.objectContaining({
						title: "Example item",
						externalId: "sku-example",
					}),
				]);
				expect(
					getAppMetadataJson((await getAppById(coreDb(env), "app-example"))!)
						?.itemImport,
				).toMatchObject({ itemsImported: 1, itemsSaved: 1 });
			});
			expect(steps).toEqual([
				"load-app-config",
				"process-batch-0",
				"update-app-metadata",
			]);
			if (pg) expect(close).toHaveBeenCalledTimes(4);
		} finally {
			engine.emitDestroy();
			sqlite?.close();
			await pg?.close();
		}
	},
);

it("closes failed callback scopes and forwards context and engine methods", async () => {
	const { withCoreStoreSteps } = await import("./core-store-step");
	const engine = new AsyncResource("workflow-engine");
	const env = { CORE_STORE: "postgres" } as CloudflareEnv;
	const db = {} as ReturnType<typeof coreDb>;
	const close = vi.fn(async () => {});
	vi.mocked(createCoreStore).mockReturnValue({ db, close });
	const context = { attempt: 1 };
	const raw = {
		async do(_name: string, callback: (context: unknown) => Promise<unknown>) {
			expect(this).toBe(raw);
			return engine.runInAsyncScope(() => callback(context));
		},
		async sleep(_name: string, _duration: string) {
			expect(this).toBe(raw);
		},
	};
	const step = withCoreStoreSteps(env, raw as never);
	try {
		await expect(
			step.do("failed", async () => {
				expect(coreDb(env)).toBe(db);
				throw new Error("step failed");
			}),
		).rejects.toThrow("step failed");
		expect(close).toHaveBeenCalledTimes(1);
		await expect(
			step.do("retry", async (ctx) => {
				expect(ctx).toBe(context);
				expect(coreDb(env)).toBe(db);
				return "stored";
			}),
		).resolves.toBe("stored");
		expect(close).toHaveBeenCalledTimes(2);
		expect(() => coreDb(env)).toThrow("requires a withCoreStore scope");
		await step.sleep("pause", "1 second");
	} finally {
		engine.emitDestroy();
	}
});
