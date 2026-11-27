import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { createDbClient, type DbClient } from "../client";
import { coreTable } from "../core-store/client";
import { workflowRunLedger } from "../schema/workflow-runs";
import { createD1Facade } from "../test/d1-facade";
import { createMigratedSqlite } from "../test/migrated-sqlite";
import { createPGliteFacade } from "../test/pglite-facade";
import {
	createWorkflowRunRecord,
	completeWorkflowRunRecord,
	getRecentWorkflowRunRecords,
	getLatestWorkflowRunRecordsByTypes,
} from "./workflow-runs";

for (const store of ["d1", "postgres"] as const) {
	describe(`platform workflow ledger (${store})`, () => {
		let db: DbClient;
		let close: () => void | Promise<void>;
		beforeAll(async () => {
			if (store === "d1") {
				const sqlite = createMigratedSqlite();
				db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
				close = () => sqlite.close();
			} else {
				const fixture = await createPGliteFacade();
				db = fixture.db;
				close = fixture.close;
				for (const migration of readMigrationFiles({
					migrationsFolder: fileURLToPath(
						new URL("../../drizzle-pg", import.meta.url),
					),
				}))
					for (const ddl of migration.sql) await fixture.engine.exec(ddl);
			}
		}, 30_000);
		afterAll(async () => {
			await close?.();
		});

		it("returns each type's latest row with stable ties and a bounded candidate set", async () => {
			await db.insert(coreTable(db, workflowRunLedger)).values([
				{
					id: "catalog-old",
					workflowType: "catalog_sync",
					workflowId: "old",
					trigger: "test",
					status: "completed",
					startedAt: "2026-07-24T00:00:00Z",
				},
				{
					id: "catalog-new-a",
					workflowType: "catalog_sync",
					workflowId: "new-a",
					trigger: "test",
					status: "completed",
					startedAt: "2026-07-24T00:02:00Z",
				},
				{
					id: "catalog-new-b",
					workflowType: "catalog_sync",
					workflowId: "new-b",
					trigger: "test",
					status: "failed",
					startedAt: "2026-07-24T00:02:00Z",
				},
				{
					id: "scan-only",
					workflowType: "mcp_scan",
					workflowId: "scan",
					trigger: "test",
					status: "completed",
					startedAt: "2026-07-24T00:01:00Z",
				},
				{
					id: "ignored",
					workflowType: "tool_test",
					workflowId: "ignored",
					trigger: "test",
					status: "completed",
					startedAt: "2026-07-24T00:03:00Z",
				},
			]);
			const rows = await getLatestWorkflowRunRecordsByTypes(db, [
				"catalog_sync",
				"mcp_scan",
				"catalog_sync",
				...Array.from({ length: 150 }, (_, i) => `missing-${i}`),
			]);
			expect(rows.map((row) => row.id)).toEqual(["catalog-new-b", "scan-only"]);
			expect(rows[0]).toMatchObject({ status: "failed", workflowId: "new-b" });
			expect(await getLatestWorkflowRunRecordsByTypes(db, [])).toEqual([]);
			expect(await getLatestWorkflowRunRecordsByTypes(db, ["missing"])).toEqual(
				[],
			);
		});

		it("returns persisted JSON and write receipts on create and completion", async () => {
			const created = await createWorkflowRunRecord(db, {
				workflowType: "receipt",
				workflowId: "receipt",
				trigger: "test",
				output: { nested: [true, null] },
			});
			expect(created).toMatchObject({
				status: "running",
				output: { nested: [true, null] },
			});
			const completed = await completeWorkflowRunRecord(db, created.id, {
				status: "completed",
				successCount: 2,
				output: { result: [1, 2] },
			});
			expect(completed).toMatchObject({
				id: created.id,
				status: "completed",
				successCount: 2,
				completedAt: expect.any(String),
				output: { result: [1, 2] },
			});
			expect(
				await completeWorkflowRunRecord(db, "missing", { status: "failed" }),
			).toBeNull();
			expect(
				await getRecentWorkflowRunRecords(db, {
					workflowType: "receipt",
					limit: 1,
				}),
			).toEqual([completed]);
			expect(await getRecentWorkflowRunRecords(db, { limit: 1 })).toEqual([
				completed,
			]);
		});
	});
}
