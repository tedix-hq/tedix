import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { createD1Facade } from "../test/d1-facade";
import { getLatestWorkflowRunRecordsByTypes } from "./workflow-runs";

function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec(`
		CREATE TABLE workflow_run_ledger (
			id TEXT PRIMARY KEY NOT NULL,
			workflow_type TEXT NOT NULL,
			workflow_id TEXT NOT NULL,
			trigger TEXT NOT NULL,
			target TEXT,
			status TEXT NOT NULL,
			started_at TEXT NOT NULL,
			completed_at TEXT,
			total_count INTEGER DEFAULT 0,
			success_count INTEGER DEFAULT 0,
			error_count INTEGER DEFAULT 0,
			output TEXT,
			error TEXT
		);
	`);
	const insert = sqlite.prepare(`
		INSERT INTO workflow_run_ledger (
			id, workflow_type, workflow_id, trigger, status, started_at
		) VALUES (?, ?, ?, 'test', ?, ?)
	`);
	return {
		db: createDbClient(createD1Facade(sqlite)),
		insert: (
			id: string,
			workflowType: string,
			status: string,
			startedAt: string,
		) => insert.run(id, workflowType, `instance-${id}`, status, startedAt),
	};
}

describe("platform workflow latest-run evidence", () => {
	it("returns one exact latest row for every requested workflow type", async () => {
		const { db, insert } = fixture();
		insert("catalog-old", "catalog_sync", "completed", "2026-07-24T00:00:00Z");
		insert("catalog-new", "catalog_sync", "failed", "2026-07-24T00:02:00Z");
		insert("scan-only", "mcp_scan", "completed", "2026-07-24T00:01:00Z");
		insert("ignored", "tool_test", "completed", "2026-07-24T00:03:00Z");

		const rows = await getLatestWorkflowRunRecordsByTypes(db, [
			"catalog_sync",
			"mcp_scan",
		]);

		expect(rows.map((row) => row.id).sort()).toEqual([
			"catalog-new",
			"scan-only",
		]);
		expect(rows.find((row) => row.id === "catalog-new")).toMatchObject({
			status: "failed",
			workflowId: "instance-catalog-new",
		});
	});

	it("returns no evidence for an empty definition page", async () => {
		const { db } = fixture();
		await expect(getLatestWorkflowRunRecordsByTypes(db, [])).resolves.toEqual(
			[],
		);
	});
});
