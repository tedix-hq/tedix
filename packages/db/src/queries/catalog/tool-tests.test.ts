import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, onTestFinished } from "vite-plus/test";
import { createDbClient } from "../../client";
import {
	appCatalog,
	appCatalogMcpTools,
	appCatalogToolTests,
} from "../../schema/catalog";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { getToolsNeedingTest, insertToolTest } from "./tool-tests";

const STAMP = "2026-08-01T00:00:00.000Z";

function realDb() {
	const sqlite = new DatabaseSync(":memory:");
	onTestFinished(() => sqlite.close());
	sqlite.exec("PRAGMA foreign_keys = ON;");
	sqlite.exec(schemaDdl(appCatalog, appCatalogMcpTools, appCatalogToolTests));
	return createDbClient(createD1Facade(sqlite));
}

async function seed(db: ReturnType<typeof realDb>) {
	await db.insert(appCatalog).values([
		{
			id: "global-app",
			name: "Global first",
			connectorType: "MCP",
			mcpEndpointNormalized: "https://global.example/mcp",
			healthStatus: "healthy",
			lastSyncedAt: STAMP,
		},
		{
			id: "target-app",
			name: "Target",
			connectorType: "MCP",
			mcpEndpointNormalized: "https://target.example/mcp",
			healthStatus: "healthy",
			lastSyncedAt: STAMP,
		},
	]);
	await db.insert(appCatalogMcpTools).values([
		{
			id: "global-never-tested",
			catalogAppId: "global-app",
			toolName: "global_tool",
			detectedAt: STAMP,
			lastSeenAt: STAMP,
		},
		{
			id: "target-low-success",
			catalogAppId: "target-app",
			toolName: "target_tool",
			detectedAt: STAMP,
			lastSeenAt: STAMP,
			lastTestedAt: new Date().toISOString(),
			testCount: 1,
			testSuccessRate: 0.1,
		},
	]);
}

describe("getToolsNeedingTest", () => {
	it("applies explicit app and tool filters before the global limit", async () => {
		const db = realDb();
		await seed(db);

		const unfiltered = await getToolsNeedingTest(db, { limit: 1 });
		expect(unfiltered.map((tool) => tool.id)).toEqual(["global-never-tested"]);
		expect(Object.keys(unfiltered[0]!).sort()).toEqual([
			"catalogAppId",
			"description",
			"id",
			"inputSchema",
			"toolName",
		]);

		const targeted = await getToolsNeedingTest(db, {
			limit: 1,
			catalogAppIds: [
				...Array.from({ length: 150 }, (_, index) => `other-app-${index}`),
				"target-app",
			],
			toolNames: [
				...Array.from({ length: 150 }, (_, index) => `other_tool_${index}`),
				"target_tool",
			],
		});
		expect(targeted.map((tool) => tool.id)).toEqual(["target-low-success"]);
	});
});

it("stores a bounded JSON preview only for oversized tool output", async () => {
	const db = realDb();
	await seed(db);
	const input = {
		catalogAppId: "target-app",
		toolName: "target_tool",
		testType: "programmatic",
		inputSource: "manual",
		success: true,
	} as const;
	const small = { ok: true };
	const large = { data: "x".repeat(12_000) };
	expect(
		(await insertToolTest(db, { ...input, outputReceived: small }))
			.outputReceived,
	).toEqual(small);
	const oversized = await insertToolTest(db, {
		...input,
		outputReceived: large,
	});
	expect(oversized.outputReceived).toEqual({
		_truncated: true,
		_originalLength: JSON.stringify(large).length,
		_preview: JSON.stringify(large).slice(0, 10_000),
	});
});
