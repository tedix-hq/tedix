import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { createDbClient } from "../client";
import { kernelRuntimeRuns } from "../schema/cognitive-runtime";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { listQuietDelegatedRuns } from "./kernel-runtime-runs";

const BEFORE = "2026-11-04T12:00:00.000Z";
const OLD = "2026-11-04T11:00:00.000Z";
const FRESH = "2026-11-04T12:00:30.000Z";

async function fixture() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(kernelRuntimeRuns));
	const db = createDbClient(createD1Facade(sqlite, { maxBoundParams: 100 }));
	const base = {
		conversationId: "home:test",
		delegatedTediId: "tedi-cto",
		createdAt: OLD,
	};
	await db.insert(kernelRuntimeRuns).values([
		{
			...base,
			id: "quiet-queued",
			organizationId: "org-a",
			status: "queued",
			childRunId: "tedi-cto:mcp:quiet-queued_auto_tedi-cto",
			startedAt: OLD,
			updatedAt: "2026-11-04T11:10:00.000Z",
		},
		{
			...base,
			id: "quiet-running",
			organizationId: "org-b",
			status: "running",
			childRunId: "tedi-cto:mcp:quiet-running_auto_tedi-cto",
			startedAt: OLD,
			updatedAt: "2026-11-04T11:05:00.000Z",
		},
		{
			...base,
			id: "recently-read",
			organizationId: "org-a",
			status: "running",
			childRunId: "tedi-cto:mcp:recently-read_auto_tedi-cto",
			startedAt: OLD,
			updatedAt: FRESH,
		},
		{
			...base,
			id: "just-dispatched",
			organizationId: "org-a",
			status: "queued",
			childRunId: "tedi-cto:mcp:just-dispatched_auto_tedi-cto",
			startedAt: FRESH,
			updatedAt: OLD,
		},
		{
			...base,
			id: "waiting-approval",
			organizationId: "org-a",
			status: "requires_approval",
			childRunId: "tedi-cto:mcp:waiting-approval_auto_tedi-cto",
			startedAt: OLD,
			updatedAt: OLD,
		},
		{
			...base,
			id: "settled",
			organizationId: "org-a",
			status: "failed",
			childRunId: "tedi-cto:mcp:settled_auto_tedi-cto",
			startedAt: OLD,
			updatedAt: OLD,
		},
		{
			...base,
			id: "not-delegated",
			organizationId: "org-a",
			status: "running",
			delegatedTediId: null,
			childRunId: null,
			startedAt: OLD,
			updatedAt: OLD,
		},
		{
			...base,
			id: "never-started",
			organizationId: "org-a",
			status: "queued",
			childRunId: "tedi-cto:mcp:never-started_auto_tedi-cto",
			startedAt: null,
			updatedAt: OLD,
		},
	]);
	return db;
}

describe("listQuietDelegatedRuns", () => {
	it("returns live delegated rows nobody touched lately, oldest first, across organizations", async () => {
		const db = await fixture();
		const rows = await listQuietDelegatedRuns(db, {
			before: BEFORE,
			limit: 10,
		});
		expect(rows.map((row) => row.id)).toEqual([
			"never-started",
			"quiet-running",
			"quiet-queued",
		]);
	});

	it("bounds one pass", async () => {
		const db = await fixture();
		const rows = await listQuietDelegatedRuns(db, { before: BEFORE, limit: 1 });
		expect(rows.map((row) => row.id)).toEqual(["never-started"]);
	});
});
