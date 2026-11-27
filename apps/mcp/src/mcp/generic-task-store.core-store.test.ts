import { AsyncResource } from "node:async_hooks";
import { fileURLToPath, URL } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it, vi } from "vite-plus/test";
import { createDbClient, type DbClient } from "@tedix/db/client";
import { coreTable, type CoreStoreEnv } from "@tedix/db/core-store/client";
import { coreDb, withCoreStore } from "@tedix/db/core-store/scope";
import { mcpTasks } from "@tedix/db/schema/mcp-tasks";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { createMigratedSqlite } from "@tedix/db/test/migrated-sqlite";
import { createPGliteFacade } from "@tedix/db/test/pglite-facade";
import { eq } from "drizzle-orm";
import {
	cancelGenericTask,
	createGenericTask,
	getGenericTaskState,
	readGenericTaskInputSnapshot,
	setGenericTaskWorkflowId,
	updateGenericTaskInput,
} from "./generic-task-store";
import { GenericTasksWorkflow } from "../workflows/generic-tasks-workflow";

const fixtureStore = vi.hoisted(() => ({ db: null as DbClient | null }));
// Keep the real scope and table selection; replace only the network client.
vi.mock("@tedix/db/core-store/client", async (importOriginal) => ({
	...(await importOriginal<typeof import("@tedix/db/core-store/client")>()),
	createCoreStore: () => ({ db: fixtureStore.db!, close: async () => {} }),
}));
vi.mock("cloudflare:workers", () => ({
	WorkflowEntrypoint: class {
		constructor(
			public ctx: unknown,
			public env: unknown,
		) {}
	},
}));
vi.mock("../subscription-publisher", () => ({
	publishMcpTaskNotification: vi.fn(async () => {}),
}));

for (const store of ["d1", "postgres"] as const) {
	describe(`generic tasks ${store}`, () => {
		let db: DbClient;
		let env: CoreStoreEnv;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				env = { DB: createD1Facade(sqlite, { maxBoundParams: 100 }) };
				db = createDbClient(env.DB!);
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../../../packages/db/drizzle-pg", import.meta.url),
					),
				})) {
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
				}
				// No D1 binding: a misplaced D1 read or replica access must fail.
				env = { CORE_STORE: "postgres" };
				fixtureStore.db = db;
			}
		}, 30000);
		afterAll(async () => {
			await close?.();
		});

		it("creates, dispatches in detached steps and polls through the selected store", async () => {
			const taskId = `generic-${crypto.randomUUID()}`;
			const fetch = vi.fn(
				async () =>
					new Response(JSON.stringify({ json: { ok: true } }), {
						headers: { "content-type": "application/json" },
					}),
			);
			const workflowEnv = {
				...env,
				API_SERVICE: { fetch },
			} as unknown as CloudflareEnv;
			await withCoreStore(env, async () => {
				await createGenericTask({
					env,
					taskId,
					orgId: "org",
					appId: "app",
					toolName: "read_runs",
					inputArgs: { limit: 5 },
					execConfig: {
						transport: "rpc",
						endpoint: "kernelRuntime/readRunSet",
						responsePath: "json",
					},
				});
				await setGenericTaskWorkflowId(env, taskId, "foreign", "wrong");
				await setGenericTaskWorkflowId(env, taskId, "org", "workflow");
				expect(await readGenericTaskInputSnapshot(env, taskId, "org")).toEqual({
					limit: 5,
				});
				expect(
					await readGenericTaskInputSnapshot(env, taskId, "foreign"),
				).toBeNull();
				expect(
					await getGenericTaskState(env, taskId, "org", undefined, {
						preferReplica: true,
					}),
				).toMatchObject({ status: "working" });
			});
			const workflow = new GenericTasksWorkflow(
				{ waitUntil: () => {} } as never,
				workflowEnv,
			);
			// Workflow step callbacks enter without the run() async context.
			const stepContext = new AsyncResource("workflow-step");
			await workflow.run(
				{ payload: { taskId } } as never,
				{
					do: async (_name: string, fn: () => Promise<unknown>) =>
						stepContext.runInAsyncScope(() => {
							if (store === "postgres")
								expect(() => coreDb(env)).toThrow(
									"requires a withCoreStore scope",
								);
							return fn();
						}),
				} as never,
			);
			stepContext.emitDestroy();
			expect(fetch).toHaveBeenCalledOnce();
			await withCoreStore(env, async () => {
				expect(
					await getGenericTaskState(env, taskId, "org", undefined, {
						preferReplica: true,
					}),
				).toMatchObject({
					status: "completed",
					result: { structuredContent: { ok: true } },
				});
				const table = coreTable(db, mcpTasks);
				const [row] = await db
					.select()
					.from(table)
					.where(eq(table.taskId, taskId));
				expect(row?.workflowId).toBe("workflow");
			});
		});

		it("enforces ownership while updating, cancelling and expiring tasks", async () => {
			await withCoreStore(env, async () => {
				const taskId = `generic-${crypto.randomUUID()}`;
				await createGenericTask({
					env,
					taskId,
					orgId: "org",
					appId: "app",
					toolName: "ask",
					caller: { userId: "owner" },
				});
				await expect(
					getGenericTaskState(env, taskId, "foreign", "owner"),
				).rejects.toMatchObject({ code: -32602 });
				await expect(
					updateGenericTaskInput(env, taskId, "org", {}, "stranger"),
				).rejects.toMatchObject({ code: -32602 });
				await expect(
					cancelGenericTask(env, taskId, "org", "stranger"),
				).rejects.toMatchObject({ code: -32602 });
				const table = coreTable(db, mcpTasks);
				await db
					.update(table)
					.set({ status: "input_required" })
					.where(eq(table.taskId, taskId));
				await updateGenericTaskInput(
					env,
					taskId,
					"org",
					{ answer: "yes" },
					"owner",
				);
				const [row] = await db
					.select()
					.from(table)
					.where(eq(table.taskId, taskId));
				expect(row).toMatchObject({
					status: "working",
					inputResponses: { answer: "yes" },
				});
				expect(
					await cancelGenericTask(env, taskId, "org", "owner"),
				).toMatchObject({ status: "cancelled" });
				await expect(
					updateGenericTaskInput(env, taskId, "org", {}, "owner"),
				).rejects.toMatchObject({ code: -32000 });
				const expiredId = `generic-${crypto.randomUUID()}`;
				await createGenericTask({
					env,
					taskId: expiredId,
					orgId: "org",
					appId: "app",
					toolName: "expired",
					ttlMs: -1,
				});
				expect(
					await getGenericTaskState(env, expiredId, "org", undefined, {
						preferReplica: true,
					}),
				).toMatchObject({ status: "failed", error: { code: -32603 } });
			});
		});
	});
}
