import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { appCatalogSyncLogs } from "../../schema/catalog";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	failRunningAppCatalogSyncLog,
	failStaleAppCatalogSyncLogs,
} from "./sync-logs";

function realDb() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(schemaDdl(appCatalogSyncLogs));
	return createDbClient(createD1Facade(sqlite));
}

describe("failStaleAppCatalogSyncLogs", () => {
	it("fails only running logs older than the explicit cutoff", async () => {
		const db = realDb();
		await db.insert(appCatalogSyncLogs).values([
			{
				id: "stale-running",
				syncType: "full",
				status: "running",
				startedAt: "2026-08-01T00:00:00.000Z",
			},
			{
				id: "recent-running",
				syncType: "full",
				status: "running",
				startedAt: "2026-08-02T01:00:00.000Z",
			},
			{
				id: "old-complete",
				syncType: "full",
				status: "completed",
				startedAt: "2026-08-01T00:00:00.000Z",
			},
		]);

		await expect(
			failStaleAppCatalogSyncLogs(
				db,
				"2026-08-02T00:00:00.000Z",
				"2026-08-02T02:00:00.000Z",
			),
		).resolves.toBe(1);

		const rows = await db.select().from(appCatalogSyncLogs);
		expect(Object.fromEntries(rows.map((row) => [row.id, row.status]))).toEqual(
			{
				"stale-running": "failed",
				"recent-running": "running",
				"old-complete": "completed",
			},
		);
	});
});

it("repairs a stranded running log without overwriting an already terminal log", async () => {
	const db = realDb();
	await db.insert(appCatalogSyncLogs).values([
		{
			id: "stranded",
			syncType: "full",
			status: "running",
			startedAt: "2026-09-19T00:00:00Z",
		},
		{
			id: "settled",
			syncType: "full",
			status: "completed",
			startedAt: "2026-09-19T00:00:00Z",
		},
	]);
	expect(
		await failRunningAppCatalogSyncLog(
			db,
			"stranded",
			"native failed",
			"2026-09-20T00:00:00Z",
		),
	).toBe(1);
	expect(
		await failRunningAppCatalogSyncLog(
			db,
			"settled",
			"native failed",
			"2026-09-20T00:00:00Z",
		),
	).toBe(0);
	expect(
		await failRunningAppCatalogSyncLog(
			db,
			"stranded",
			"later error",
			"2026-09-21T00:00:00Z",
		),
	).toBe(0);
	const rows = await db.select().from(appCatalogSyncLogs);
	expect(rows.find((row) => row.id === "stranded")?.error).toBe(
		"native failed",
	);
});
