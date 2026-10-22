import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { appCatalog, appCatalogMcpTools } from "../../schema/catalog";
import { createD1Facade } from "../../test/d1-facade";
import {
	duplicateOutputColumns,
	outputColumnNames,
} from "../../test/output-columns";
import { schemaDdl } from "../../test/schema-ddl";
import { calculateAndUpdateScores } from "./quality-scores";

const NOW = "2026-10-20T12:00:00.000Z";
type AppInput = typeof appCatalog.$inferInsert;
type ToolInput = typeof appCatalogMcpTools.$inferInsert;
const databases: DatabaseSync[] = [];

afterEach(() => {
	for (const sqlite of databases.splice(0)) sqlite.close();
});

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(appCatalog, appCatalogMcpTools));
	const queries: string[] = [];
	const db = createDbClient(
		createD1Facade(sqlite, {
			onPrepare: (query) => {
				queries.push(query);
			},
		}),
	);
	const seedApp = (id: string, overrides: Partial<AppInput> = {}) =>
		db.insert(appCatalog).values({
			id,
			name: id,
			slug: id,
			connectorType: "MCP",
			mcpToolCount: 1,
			lastSyncedAt: NOW,
			...overrides,
		});
	const seedTool = (id: string, overrides: Partial<ToolInput> = {}) =>
		db.insert(appCatalogMcpTools).values({
			id,
			catalogAppId: "app",
			toolName: "get_record",
			detectedAt: NOW,
			lastSeenAt: NOW,
			...overrides,
		});
	const readScores = async (id = "app") =>
		(
			await db
				.select({ scores: appCatalog.scores })
				.from(appCatalog)
				.where(eq(appCatalog.id, id))
		)[0]?.scores;
	return { db, queries, seedApp, seedTool, readScores };
}

describe("catalog quality score components", () => {
	it("uses baseline scores when metadata and tool snapshot rows are missing", async () => {
		const { db, seedApp, readScores } = setup();
		await seedApp("app");
		expect(await calculateAndUpdateScores(db)).toBe(1);
		expect(await readScores()).toEqual({
			schemaQuality: 0,
			capabilityBreadth: 4,
			freshness: 50,
			standards: 30,
			trust: 30,
			overall: 20,
			lastCalculatedAt: expect.any(String),
		});
	});

	it.each([
		{
			name: "x",
			description: null,
			schema: { properties: {} },
			annotations: null,
			expected: 0,
		},
		{
			name: "read",
			description: "abc",
			schema: { properties: { id: {} } },
			annotations: {},
			expected: 21,
		},
		{
			name: "get_record",
			description: "x".repeat(90),
			schema: { properties: { a: {}, b: {}, c: {} } },
			annotations: { readOnlyHint: false },
			expected: 100,
		},
		{
			name: "get_record",
			description: "x".repeat(300),
			schema: { properties: { a: {}, b: {}, c: {}, d: {} } },
			annotations: { readOnlyHint: true },
			expected: 100,
		},
	])(
		"scores schema quality for $name at $expected",
		async ({ name, description, schema, annotations, expected }) => {
			const { db, seedApp, seedTool, readScores } = setup();
			await seedApp("app");
			await seedTool("tool", {
				toolName: name,
				description,
				inputSchema: { ...schema, type: "object" },
				annotations,
			});
			await calculateAndUpdateScores(db);
			expect((await readScores())?.schemaQuality).toBe(expected);
		},
	);

	it("averages tool documentation and excludes removed tools", async () => {
		const { db, seedApp, seedTool, readScores } = setup();
		await seedApp("app", { mcpToolCount: 2 });
		await seedTool("complete", {
			description: "x".repeat(90),
			inputSchema: { type: "object", properties: { a: {}, b: {}, c: {} } },
			annotations: { readOnlyHint: true },
		});
		await seedTool("bare", { toolName: "x" });
		await seedTool("removed", { toolName: "y", removedAt: NOW });
		await calculateAndUpdateScores(db);
		expect(await readScores()).toMatchObject({
			schemaQuality: 50,
			standards: 40,
		});
	});

	it.each([
		{ input: { mcpResourceCount: null, mcpPromptCount: null }, expected: 4 },
		{ input: { mcpToolCount: 10 }, expected: 40 },
		{ input: { mcpToolCount: 1000 }, expected: 40 },
		{ input: { mcpResourceCount: 1 }, expected: 14 },
		{ input: { mcpResourceCount: 20 }, expected: 24 },
		{ input: { mcpPromptCount: 20 }, expected: 19 },
		{ input: { hasWrites: true }, expected: 10 },
		{ input: { hasInteractive: true }, expected: 10 },
		{ input: { hasFileSearch: true }, expected: 10 },
		{ input: { hasDeepResearch: true }, expected: 10 },
		{
			input: {
				mcpToolCount: 100,
				mcpResourceCount: 100,
				mcpPromptCount: 100,
				hasWrites: true,
				hasInteractive: true,
				hasFileSearch: true,
				hasDeepResearch: true,
			},
			expected: 100,
		},
	])(
		"scores capability breadth as $expected for $input",
		async ({ input, expected }) => {
			const { db, seedApp, readScores } = setup();
			await seedApp("app", input);
			await calculateAndUpdateScores(db);
			expect((await readScores())?.capabilityBreadth).toBe(expected);
		},
	);

	it.each([
		{ version: null, health: "unknown", expected: 50 },
		{ version: "preview", health: "unhealthy", expected: 70 },
		{ version: "1.2.3", health: "unhealthy", expected: 80 },
		{ version: null, health: "healthy", expected: 70 },
		{ version: "1.2.3", health: "healthy", expected: 100 },
	] as const)(
		"scores freshness from $version and $health",
		async ({ version, health, expected }) => {
			const { db, seedApp, readScores } = setup();
			await seedApp("app", {
				mcpMetadata: { serverVersion: version },
				healthStatus: health,
			});
			await calculateAndUpdateScores(db);
			expect((await readScores())?.freshness).toBe(expected);
		},
	);

	it.each(["2000-01-01T00:00:00.000Z", NOW])(
		"uses version and health even with scan timestamp %s",
		async (lastScannedAt) => {
			const { db, seedApp, readScores } = setup();
			await seedApp("app", {
				mcpMetadata: { lastScannedAt, serverVersion: "1.0.0" },
				healthStatus: "healthy",
			});
			await calculateAndUpdateScores(db);
			expect((await readScores())?.freshness).toBe(100);
		},
	);

	it.each([
		{ capabilities: null, expected: 30 },
		{ capabilities: {}, expected: 30 },
		{ capabilities: { tools: {} }, expected: 50 },
		{ capabilities: { resources: {} }, expected: 45 },
		{ capabilities: { prompts: {} }, expected: 45 },
		{ capabilities: { tools: {}, resources: {}, prompts: {} }, expected: 80 },
	])(
		"scores standards as $expected without annotated tools",
		async ({ capabilities, expected }) => {
			const { db, seedApp, readScores } = setup();
			await seedApp("app", { mcpMetadata: { capabilities } });
			await calculateAndUpdateScores(db);
			expect((await readScores())?.standards).toBe(expected);
		},
	);

	it.each([
		[null, 30],
		["OAI", 100],
		["TRUSTED_PARTNER", 80],
		["THIRD_PARTY", 50],
	] as const)("scores developer trust for %s", async (developerType, trust) => {
		const { db, seedApp, readScores } = setup();
		await seedApp("app", { developerType });
		await calculateAndUpdateScores(db);
		expect((await readScores())?.trust).toBe(trust);
	});

	it("combines distinct dimensions with 25/25/20/15/15 percent weights", async () => {
		const { db, seedApp, seedTool, readScores } = setup();
		await seedApp("app", {
			mcpToolCount: 10,
			mcpMetadata: { serverVersion: "1.0.0", capabilities: { tools: {} } },
			developerType: "TRUSTED_PARTNER",
		});
		await seedTool("tool");
		await calculateAndUpdateScores(db);
		expect(await readScores()).toMatchObject({
			schemaQuality: 20,
			capabilityBreadth: 40,
			freshness: 80,
			standards: 50,
			trust: 80,
			overall: 51,
		});
	});

	it("reaches 100 when all five weighted dimensions are maximal", async () => {
		const { db, seedApp, seedTool, readScores } = setup();
		await seedApp("app", {
			mcpToolCount: 10,
			mcpResourceCount: 2,
			mcpPromptCount: 1,
			hasWrites: true,
			hasInteractive: true,
			hasFileSearch: true,
			hasDeepResearch: true,
			developerType: "OAI",
			healthStatus: "healthy",
			mcpMetadata: {
				serverVersion: "1.0.0",
				capabilities: { tools: {}, resources: {}, prompts: {} },
			},
		});
		await seedTool("tool", {
			description: "x".repeat(90),
			inputSchema: { type: "object", properties: { a: {}, b: {}, c: {} } },
			annotations: { readOnlyHint: true },
		});
		await calculateAndUpdateScores(db);
		expect(await readScores()).toMatchObject({
			schemaQuality: 100,
			capabilityBreadth: 100,
			freshness: 100,
			standards: 100,
			trust: 100,
			overall: 100,
		});
	});
});

describe("calculateAndUpdateScores", () => {
	it("returns zero with no eligible apps", async () => {
		const { db } = setup();
		expect(await calculateAndUpdateScores(db)).toBe(0);
	});

	it("updates only discoverable MCP apps with positive scanned tool counts", async () => {
		const { db, seedApp, readScores } = setup();
		await seedApp("app");
		for (const [id, overrides] of [
			["zero", { mcpToolCount: 0 }],
			["unknown", { mcpToolCount: null }],
			["hidden", { isDiscoverable: false }],
			["service", { connectorType: "SERVICE" }],
		] as const)
			await seedApp(id, { ...overrides, scores: { overall: 7 } });
		expect(await calculateAndUpdateScores(db)).toBe(1);
		expect((await readScores())?.overall).toBe(20);
		for (const id of ["zero", "unknown", "hidden", "service"])
			expect(await readScores(id)).toEqual({ overall: 7 });
	});

	it("honours limit, prioritizes unscored then oldest scores, and preserves conformance fields", async () => {
		const { db, seedApp, readScores } = setup();
		await seedApp("recent", { scores: { overall: 7, lastCalculatedAt: NOW } });
		await seedApp("old", {
			scores: { overall: 8, lastCalculatedAt: "2000-01-01T00:00:00.000Z" },
		});
		await seedApp("app", {
			scores: { implementsRetrievable: true, retrievableReason: "fixture" },
		});
		expect(await calculateAndUpdateScores(db, 0)).toBe(0);
		expect(await calculateAndUpdateScores(db, 1)).toBe(1);
		expect(await readScores()).toMatchObject({
			overall: 20,
			implementsRetrievable: true,
			retrievableReason: "fixture",
			lastCalculatedAt: expect.any(String),
		});
		expect((await readScores("old"))?.overall).toBe(8);
		expect(await calculateAndUpdateScores(db, 1)).toBe(1);
		expect((await readScores("old"))?.overall).toBe(20);
		expect((await readScores("recent"))?.overall).toBe(7);
	});

	it("defaults to 50 apps and chunks larger tool reads below D1's parameter ceiling", async () => {
		const { db, seedApp } = setup();
		for (let i = 0; i < 105; i++) await seedApp(`app-${i}`);
		expect(await calculateAndUpdateScores(db)).toBe(50);
		expect(await calculateAndUpdateScores(db, 105)).toBe(105);
	});

	it("uses unique output column names in both reads for D1 batch safety", async () => {
		const { db, seedApp, seedTool, queries } = setup();
		await seedApp("app");
		await seedTool("tool");
		queries.length = 0;
		await calculateAndUpdateScores(db);
		const selects = queries.filter((query) => query.startsWith("select "));
		expect(selects).toHaveLength(2);
		for (const query of selects) {
			expect(outputColumnNames(query).length).toBeGreaterThan(0);
			expect(duplicateOutputColumns(query)).toEqual([]);
		}
	});
});
