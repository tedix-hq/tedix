import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../client";
import { appTools } from "../schema/tools";
import { createD1Facade } from "../test/d1-facade";
import { schemaDdl } from "../test/schema-ddl";
import { listToolsPage } from "./tools";

const APP_ID = "5eed0020-0000-4000-8000-000000000020";
const OTHER_APP_ID = "11111111-1111-4111-8111-111111111111";

async function setupTools(
	rows: Array<{
		id: string;
		toolId: string;
		title?: string;
		description?: string;
		appId?: string;
		sortOrder?: number;
	}>,
) {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(schemaDdl(appTools));
	const db = createDbClient(createD1Facade(sqlite));
	for (const [index, row] of rows.entries()) {
		await db.insert(appTools).values({
			id: row.id,
			appId: row.appId ?? APP_ID,
			toolId: row.toolId,
			title: row.title ?? row.toolId,
			description: row.description,
			toolTypeId: "rpc",
			sortOrder: row.sortOrder ?? index,
			createdAt: "2026-08-31T00:00:00.000Z",
			updatedAt: "2026-08-31T00:00:00.000Z",
		});
	}
	return db;
}

describe("listToolsPage", () => {
	it("returns one stable page with exact tenant-scoped counts", async () => {
		const rows = Array.from({ length: 61 }, (_, index) => ({
			id: `tool-${index + 1}`,
			toolId: `tool_${index + 1}`,
			appId: index === 60 ? OTHER_APP_ID : APP_ID,
		}));
		const db = await setupTools(rows);

		const page = await listToolsPage(db, APP_ID, { limit: 25, offset: 25 });

		expect(page.inventoryTotal).toBe(60);
		expect(page.total).toBe(60);
		expect(page.rows).toHaveLength(25);
		expect(page.rows[0]?.toolId).toBe("tool_26");
		expect(page.rows.at(-1)?.toolId).toBe("tool_50");
	});

	it("searches the complete inventory with normalized all-term matching", async () => {
		const db = await setupTools([
			{
				id: "issues",
				toolId: "github_list_issues",
				title: "List issues",
				description: "Lists open issues for a repository",
			},
			{
				id: "pull",
				toolId: "githubCreatePull",
				title: "Create pull request",
			},
			{ id: "workflow", toolId: "run_skill_workflow" },
		]);

		const spaced = await listToolsPage(db, APP_ID, {
			limit: 25,
			offset: 0,
			query: "github repository",
		});
		expect(spaced.rows.map((row) => row.id)).toEqual(["issues"]);
		expect(spaced.total).toBe(1);
		expect(spaced.inventoryTotal).toBe(3);

		const camel = await listToolsPage(db, APP_ID, {
			limit: 25,
			offset: 0,
			query: "listIssues",
		});
		expect(camel.rows.map((row) => row.id)).toEqual(["issues"]);

		const crossField = await listToolsPage(db, APP_ID, {
			limit: 25,
			offset: 0,
			query: "github create",
		});
		expect(crossField.rows.map((row) => row.id)).toEqual(["pull"]);

		const literalWildcard = await listToolsPage(db, APP_ID, {
			limit: 25,
			offset: 0,
			query: "%",
		});
		expect(literalWildcard.total).toBe(0);
		expect(literalWildcard.inventoryTotal).toBe(3);
	});
});
