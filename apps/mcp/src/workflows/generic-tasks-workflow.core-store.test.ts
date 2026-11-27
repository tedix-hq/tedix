import { AsyncResource } from "node:async_hooks";
import { fileURLToPath, URL } from "node:url";
import { createCoreStore, coreTable } from "@tedix/db/core-store/client";
import { coreDb, withCoreStore } from "@tedix/db/core-store/scope";
import { mcpTasks } from "@tedix/db/schema/mcp-tasks";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { createPGliteFacade } from "@tedix/db/test/pglite-facade";
import { eq } from "drizzle-orm";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { expect, it, vi } from "vite-plus/test";
import { GenericTasksWorkflow } from "./generic-tasks-workflow";

vi.mock("@tedix/db/core-store/client", async (original) => ({
	...(await original<typeof import("@tedix/db/core-store/client")>()),
	createCoreStore: vi.fn(),
}));
vi.mock("../subscription-publisher", () => ({
	publishMcpTaskNotification: vi.fn(),
}));

it.each(["postgres", "d1"] as const)(
	"completes and cancels tasks across detached step callbacks on %s",
	async (dialect) => {
		const engine = new AsyncResource("workflow-engine");
		const sqlite = dialect === "d1" ? createMigratedSqlite() : undefined;
		const pg = dialect === "postgres" ? await createPGliteFacade() : undefined;
		const close = vi.fn(async () => {});
		const fetch = vi.fn(
			async () =>
				new Response(JSON.stringify({ json: { ok: true } }), {
					headers: { "content-type": "application/json" },
				}),
		);
		const env = {
			CORE_STORE: dialect,
			DB: sqlite ? createD1Facade(sqlite) : undefined,
			API_SERVICE: { fetch },
		} as unknown as CloudflareEnv;
		try {
			if (pg) {
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../../packages/db/drizzle-pg", import.meta.url),
					),
				}))
					for (const sql of migration.sql) await pg.engine.exec(sql);
				vi.mocked(createCoreStore).mockImplementation(() => {
					// A callback must use its own client, never the one captured by run().
					const db = new Proxy(pg.db, {
						get(target, key, receiver) {
							if (key === "select" || key === "update")
								expect(coreDb(env)).toBe(db);
							return Reflect.get(target, key, receiver);
						},
					});
					return { db, close };
				});
			}
			const workflow = new GenericTasksWorkflow(
				{ waitUntil: vi.fn() } as never,
				env,
			);
			const steps: string[] = [];
			const step = {
				do(name: string, callback: () => Promise<unknown>) {
					steps.push(name);
					return engine.runInAsyncScope(async () => {
						if (pg)
							expect(() => coreDb(env)).toThrow(
								"requires a withCoreStore scope",
							);
						const closedBefore = close.mock.calls.length;
						const result = await callback();
						if (pg) expect(close).toHaveBeenCalledTimes(closedBefore + 1);
						return result;
					});
				},
			};
			for (const cancelled of [false, true]) {
				const taskId = `generic-${crypto.randomUUID()}`;
				await withCoreStore(env, async () => {
					const db = coreDb(env);
					await db.insert(coreTable(db, mcpTasks)).values({
						id: crypto.randomUUID(),
						taskId,
						orgId: "org-example",
						appId: "app-example",
						toolName: "example_read",
						cancelRequestedAt: cancelled ? new Date().toISOString() : null,
						inputRequests: {
							input: {},
							execConfig: {
								transport: "rpc",
								endpoint: "kernelRuntime/readRunSet",
							},
						},
					});
				});
				await workflow.run({ payload: { taskId } } as never, step as never);
				await withCoreStore(env, async () => {
					const db = coreDb(env);
					const table = coreTable(db, mcpTasks);
					const [row] = await db
						.select()
						.from(table)
						.where(eq(table.taskId, taskId));
					expect(row?.status).toBe(cancelled ? "cancelled" : "completed");
					if (!cancelled)
						expect(row?.result).toMatchObject({
							structuredContent: { ok: true },
						});
				});
			}
			expect(fetch).toHaveBeenCalledTimes(1);
			expect(steps).toEqual([
				"load-task",
				"dispatch",
				"write-terminal",
				"load-task",
				"write-cancelled",
			]);
		} finally {
			engine.emitDestroy();
			sqlite?.close();
			await pg?.close();
		}
	},
);
