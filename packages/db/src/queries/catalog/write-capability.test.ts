import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { deriveToolWriteCapability } from "@tedix/api-contract/schemas/tools";
import { describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { apps } from "../../schema/apps";
import { appTools } from "../../schema/tools";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import { reportUnclassifiedWriteCapability } from "./write-capability";

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(apps, appTools));
	return createDbClient(createD1Facade(sqlite));
}

type Db = ReturnType<typeof setup>;

async function seedApp(db: Db, id: string, slug: string) {
	await db.insert(apps).values({
		id,
		organizationId: "org-1",
		name: slug,
		slug,
		visibility: "public",
	});
}

async function seedTool(
	db: Db,
	values: Partial<typeof appTools.$inferInsert> & {
		id: string;
		appId: string;
		toolId: string;
	},
) {
	await db.insert(appTools).values({
		title: values.toolId,
		toolTypeId: "mcp",
		enabled: true,
		...values,
	});
}

describe("reportUnclassifiedWriteCapability", () => {
	it("lists every undeclared tool with the app and the reason it is unclassified", async () => {
		const db = setup();
		await seedApp(db, "app-1", "atlassian");
		await seedApp(db, "app-2", "cms");

		// Upstream sends nothing → needs an explicit declaration.
		await seedTool(db, {
			id: "t-1",
			appId: "app-1",
			toolId: "createJiraIssue",
			schemaSource: "mcp",
		});
		// Annotated but the hints classify nothing.
		await seedTool(db, {
			id: "t-2",
			appId: "app-1",
			toolId: "getJiraIssue",
			annotations: { idempotentHint: true },
		});
		// Hints DO classify — the column just was never populated.
		await seedTool(db, {
			id: "t-3",
			appId: "app-2",
			toolId: "content_restore",
			annotations: { readOnlyHint: false },
		});
		// Already declared — must not appear.
		await seedTool(db, {
			id: "t-4",
			appId: "app-2",
			toolId: "content_delete",
			annotations: { destructiveHint: true },
			writeCapability: "destructive",
		});
		// Declared read-only — must not appear either. A report that listed
		// declared reads would be the same "everything is suspicious" noise the
		// gating change is trying to avoid.
		await seedTool(db, {
			id: "t-5",
			appId: "app-2",
			toolId: "content_list",
			annotations: { readOnlyHint: true },
			writeCapability: "read",
		});

		const report = await reportUnclassifiedWriteCapability(db);

		expect(report.totalTools).toBe(3);
		expect(report.totalApps).toBe(2);
		expect(report.truncated).toBe(false);
		expect(report.items.map((i) => i.toolId).sort()).toEqual([
			"content_restore",
			"createJiraIssue",
			"getJiraIssue",
		]);

		const byTool = new Map(report.items.map((i) => [i.toolId, i]));
		expect(byTool.get("createJiraIssue")).toMatchObject({
			appSlug: "atlassian",
			reason: "no_annotations",
			derivable: null,
			schemaSource: "mcp",
		});
		expect(byTool.get("getJiraIssue")).toMatchObject({
			reason: "inconclusive_annotations",
			derivable: null,
		});
		// Actionable: says exactly what a re-sync would write.
		expect(byTool.get("content_restore")).toMatchObject({
			appSlug: "cms",
			reason: "stale_sync",
			derivable: "write",
		});
		expect(report.summary).toContain("1 fixable by re-syncing");
	});

	// The report's stated job is "every currently unclassified tool". Scoping it
	// to enabled rows made the backlog look smaller than it is — a disabled row
	// is one re-enable away from being a live undeclared tool, and a backlog
	// report that under-counts itself is the one failure it cannot have.
	it("counts a DISABLED undeclared tool, and says it is disabled", async () => {
		const db = setup();
		await seedApp(db, "app-1", "atlassian");
		await seedTool(db, {
			id: "t-off",
			appId: "app-1",
			toolId: "nuke_tenant",
			enabled: false,
			writeCapability: null,
		});

		const report = await reportUnclassifiedWriteCapability(db, {});

		expect(report.totalTools).toBe(1);
		const item = report.items.find((row) => row.toolId === "nuke_tenant");
		expect(item).toBeDefined();
		expect(item?.enabled).toBe(false);
	});

	it("reports exact totals even when the listing is truncated", async () => {
		const db = setup();
		await seedApp(db, "app-1", "atlassian");
		for (let i = 0; i < 5; i++) {
			await seedTool(db, {
				id: `t-${i}`,
				appId: "app-1",
				toolId: `undeclared_${i}`,
			});
		}

		const report = await reportUnclassifiedWriteCapability(db, { limit: 2 });
		// The backlog size must be honest regardless of how much is enumerated.
		expect(report.totalTools).toBe(5);
		expect(report.listed).toBe(2);
		expect(report.truncated).toBe(true);
		expect(report.summary).toContain("Listed 2 of 5");
	});

	it("says so when nothing is unclassified", async () => {
		const db = setup();
		await seedApp(db, "app-1", "acme");
		await seedTool(db, {
			id: "t-1",
			appId: "app-1",
			toolId: "acme_get",
			writeCapability: "read",
		});
		const report = await reportUnclassifiedWriteCapability(db);
		expect(report.totalTools).toBe(0);
		expect(report.items).toEqual([]);
		expect(report.summary).toContain("Every tool declares");
	});
});

/**
 * The backfill migration hand-writes the derivation in SQL. That duplicate is
 * the kind of thing that drifts silently, so pin it against the TypeScript
 * helper it mirrors — every annotation shape must land on the same answer,
 * including the ones that must stay NULL.
 */
describe("backfill migration matches deriveToolWriteCapability", () => {
	const SHAPES: Array<Record<string, boolean | string> | null> = [
		null,
		{},
		{ readOnlyHint: true },
		{ readOnlyHint: false },
		{ destructiveHint: true },
		{ destructiveHint: false },
		{ readOnlyHint: true, destructiveHint: false },
		{ readOnlyHint: false, destructiveHint: true },
		{ readOnlyHint: true, destructiveHint: true },
		{ idempotentHint: true },
		{ openWorldHint: false },
		{ title: "Thing" },
	];

	it("derives the same capability for every annotation shape", async () => {
		const db = setup();
		await seedApp(db, "app-1", "acme");
		for (const [index, annotations] of SHAPES.entries()) {
			await seedTool(db, {
				id: `t-${index}`,
				appId: "app-1",
				toolId: `tool_${index}`,
				annotations: annotations as never,
			});
		}

		const sql = readFileSync(
			new URL(
				"../../../drizzle/20260818185154_backfill_app_tools_write_capability/migration.sql",
				import.meta.url,
			),
			"utf8",
		);
		// Run the migration's own statement, not a paraphrase of it.
		await db.run(sql.split("--> statement-breakpoint")[0]!.trim() as never);

		const rows = await db
			.select({
				toolId: appTools.toolId,
				writeCapability: appTools.writeCapability,
			})
			.from(appTools);
		const byTool = new Map(rows.map((r) => [r.toolId, r.writeCapability]));
		for (const [index, annotations] of SHAPES.entries()) {
			expect({
				shape: annotations,
				value: byTool.get(`tool_${index}`) ?? null,
			}).toEqual({
				shape: annotations,
				value: deriveToolWriteCapability(annotations as never),
			});
		}
	});
});
