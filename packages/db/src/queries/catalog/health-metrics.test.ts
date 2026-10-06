/**
 * `app_catalog.updatedAt` is public: the directory page renders it as
 * "Directory updated" and emits it as schema.org `dateModified`, and the catalog
 * offers a sortBy=updatedAt. A health scan runs against every app on a schedule,
 * so stamping it unconditionally made every listing claim scan-cadence freshness.
 * These pin that the stamp tracks observed change, not scan cadence.
 */

import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vite-plus/test";
import { createDbClient } from "../../client";
import { appCatalog, appCatalogHealthHistory } from "../../schema/catalog";
import { apps } from "../../schema/apps";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	buildCatalogQualityScorecard,
	getCatalogHealthSummary,
	getCatalogAppsNeedingScan,
	updateCatalogAppHealthMetrics,
} from "./health-metrics";

const STAMP = "2020-01-01T00:00:00.000Z";

describe("buildCatalogQualityScorecard", () => {
	it("turns persisted backlog and freshness debt into safe remediation queues", () => {
		const scorecard = buildCatalogQualityScorecard({
			total: 100,
			unknown: 10,
			healthy: 20,
			unhealthy: 60,
			protocolInventory: { enabled: { total: 100, staleOrUnscanned: 70 } },
			scanBacklog: {
				totalEnabledMcp: 100,
				dueNow: 60,
				staleOver24h: 70,
				staleOver7d: 20,
				skippedRequiresAuth: 0,
				skippedBlocked: 0,
				blockedZeroToolCandidates: 0,
				unhealthyZeroToolCandidates: 0,
			},
		});

		expect(scorecard.grade).toBe("critical");
		expect(scorecard.remediation).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ key: "scan_backlog", severity: "warning" }),
				expect.objectContaining({
					key: "unhealthy_inventory",
					severity: "warning",
				}),
				expect.objectContaining({
					key: "protocol_freshness",
					severity: "warning",
				}),
			]),
		);
		expect(scorecard.remediation[0]?.action).toContain(
			"bounded MCP scan batches",
		);
	});
});

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	sqlite.exec("PRAGMA foreign_keys = OFF;");
	sqlite.exec(schemaDdl(appCatalog, appCatalogHealthHistory, apps));
	return createDbClient(createD1Facade(sqlite));
}

describe("getCatalogAppsNeedingScan", () => {
	it("prioritizes due Tedix-owned endpoints ahead of catalog backlog", async () => {
		const db = setup();
		for (const row of [
			{
				id: "external",
				name: "External",
				slug: "external",
				mcpEndpointNormalized: "https://mcp.example.com/mcp",
			},
			{
				id: "first-party",
				name: "First party",
				slug: "first-party",
				mcpEndpointNormalized: "https://first-party.mcp.tedix.dev/mcp",
			},
		]) {
			await db.insert(appCatalog).values({
				...row,
				toolSource: "upstream_mcp",
				connectorType: "MCP",
				healthStatus: "unknown",
				lastSyncedAt: STAMP,
				createdAt: STAMP,
				updatedAt: STAMP,
			});
		}

		const [next] = await getCatalogAppsNeedingScan(db, { limit: 1 });
		expect(next?.id).toBe("first-party");
	});
});

async function seed(db: ReturnType<typeof setup>) {
	await db.insert(appCatalog).values({
		id: "cat-1",
		name: "Example",
		slug: "example",
		toolSource: "upstream_mcp",
		connectorType: "MCP",
		lastSyncedAt: STAMP,
		healthStatus: "healthy",
		mcpToolCount: 7,
		createdAt: STAMP,
		updatedAt: STAMP,
	});
}

const scan = (over: Record<string, unknown> = {}) => ({
	status: "healthy" as const,
	checkedAt: "2026-07-30T12:00:00.000Z",
	toolCount: 7,
	...over,
});

async function updatedAtOf(db: ReturnType<typeof setup>) {
	const [row] = await db
		.select({ updatedAt: appCatalog.updatedAt })
		.from(appCatalog)
		.where(eq(appCatalog.id, "cat-1"));
	return row?.updatedAt ?? null;
}

describe("updateCatalogAppHealthMetrics", () => {
	let db: ReturnType<typeof setup>;

	beforeEach(async () => {
		db = setup();
		await seed(db);
	});

	it("does not restamp freshness when a scan observes no change", async () => {
		await updateCatalogAppHealthMetrics(db, "cat-1", scan());
		expect(await updatedAtOf(db)).toBe(STAMP);
	});

	it("still records the poll itself", async () => {
		await updateCatalogAppHealthMetrics(db, "cat-1", scan());
		const [row] = await db
			.select({ healthData: appCatalog.healthData })
			.from(appCatalog)
			.where(eq(appCatalog.id, "cat-1"));
		// The scan is written even though the freshness stamp is untouched —
		// only `updatedAt` is conditional.
		expect(row?.healthData?.lastCheckedAt).toBe("2026-07-30T12:00:00.000Z");
	});

	it("advances protocol freshness only when a scan negotiates a revision", async () => {
		await updateCatalogAppHealthMetrics(
			db,
			"cat-1",
			scan({ protocolVersion: "2026-07-28" }),
		);
		await updateCatalogAppHealthMetrics(
			db,
			"cat-1",
			scan({
				checkedAt: "2026-07-31T12:00:00.000Z",
				protocolVersion: undefined,
				status: "requires_auth",
			}),
		);
		const [row] = await db
			.select({ mcpMetadata: appCatalog.mcpMetadata })
			.from(appCatalog)
			.where(eq(appCatalog.id, "cat-1"));
		expect(row?.mcpMetadata?.protocolObservedAt).toBe(
			"2026-07-30T12:00:00.000Z",
		);
	});

	it("restamps when health status changes", async () => {
		await updateCatalogAppHealthMetrics(db, "cat-1", scan({ status: "down" }));
		expect(await updatedAtOf(db)).not.toBe(STAMP);
	});

	it("restamps when the tool count changes", async () => {
		await updateCatalogAppHealthMetrics(db, "cat-1", scan({ toolCount: 9 }));
		expect(await updatedAtOf(db)).not.toBe(STAMP);
	});

	it("treats an absent field as unchanged rather than as a change", async () => {
		// `toolCount` omitted — the writer falls back to the stored value, so this
		// must not read as a transition to undefined.
		await updateCatalogAppHealthMetrics(
			db,
			"cat-1",
			scan({ toolCount: undefined }),
		);
		expect(await updatedAtOf(db)).toBe(STAMP);
	});
});

describe("getCatalogHealthSummary protocol inventory", () => {
	it("bounds the legacy app sample while preserving the total", async () => {
		const db = setup();
		for (let index = 0; index < 26; index++) {
			await db.insert(appCatalog).values({
				id: `legacy-${index}`,
				name: `Legacy ${index}`,
				slug: `legacy-${String(index).padStart(2, "0")}`,
				toolSource: "upstream_mcp",
				connectorType: "MCP",
				mcpEndpointNormalized: `https://legacy-${index}.example/mcp`,
				protocolVersion: "2025-03-26",
				healthStatus: "healthy",
				lastSyncedAt: STAMP,
				createdAt: STAMP,
				updatedAt: STAMP,
			});
		}
		await db.insert(appCatalog).values({
			id: "disabled-legacy",
			name: "Disabled Legacy",
			slug: "00-disabled-legacy",
			toolSource: "upstream_mcp",
			connectorType: "MCP",
			mcpEndpointNormalized: "https://disabled-legacy.example/mcp",
			protocolVersion: "2025-03-26",
			healthStatus: "healthy",
			status: "DISABLED",
			lastSyncedAt: STAMP,
			createdAt: STAMP,
			updatedAt: STAMP,
		});

		const inventory = (await getCatalogHealthSummary(db)).protocolInventory;
		expect(inventory.legacyStreamable).toBe(27);
		expect(inventory.legacyApps).toHaveLength(25);
		expect(inventory.legacyApps).not.toContainEqual(
			expect.objectContaining({ slug: "00-disabled-legacy" }),
		);
		expect(inventory.legacyAppsTruncated).toBe(true);
	});

	it("classifies persisted modern, legacy streamable, legacy SSE, and unknown servers", async () => {
		const db = setup();
		const freshCheckedAt = new Date().toISOString();
		const rows = [
			{
				id: "modern",
				name: "Modern",
				slug: "modern",
				toolSource: "upstream_mcp",
				connectorType: "MCP",
				mcpEndpointNormalized: "https://modern.mcp.tedix.dev/mcp",
				protocolVersion: "2026-07-28",
				healthStatus: "healthy",
				healthData: { lastCheckedAt: freshCheckedAt },
				mcpMetadata: { protocolObservedAt: freshCheckedAt },
				createdAt: STAMP,
				updatedAt: STAMP,
			},
			{
				id: "streamable",
				name: "Legacy Streamable",
				slug: "legacy-streamable",
				toolSource: "upstream_mcp",
				connectorType: "MCP",
				mcpEndpointNormalized: "https://streamable.example/mcp",
				protocolVersion: "2025-03-26",
				healthStatus: "degraded",
				healthData: {
					transportUsed: "streamable-http",
					lastCheckedAt: freshCheckedAt,
				},
				mcpMetadata: { protocolObservedAt: freshCheckedAt },
				createdAt: STAMP,
				updatedAt: STAMP,
			},
			{
				id: "sse",
				name: "Legacy SSE",
				slug: "legacy-sse",
				toolSource: "upstream_mcp",
				connectorType: "MCP",
				mcpEndpointNormalized: "https://sse.example/sse",
				protocolVersion: "2024-11-05",
				healthStatus: "healthy",
				healthData: {
					transportUsed: "sse",
					lastCheckedAt: "2026-08-22T12:00:00.000Z",
				},
				mcpMetadata: {
					protocolObservedAt: "2026-08-22T12:00:00.000Z",
				},
				createdAt: STAMP,
				updatedAt: STAMP,
			},
			{
				id: "unknown",
				name: "Unknown",
				slug: "unknown",
				toolSource: "upstream_mcp",
				connectorType: "MCP",
				mcpEndpointNormalized: "https://unknown.example/mcp",
				healthStatus: "unknown",
				createdAt: STAMP,
				updatedAt: STAMP,
			},
			{
				id: "disabled-modern",
				name: "Disabled Modern",
				slug: "disabled-modern",
				toolSource: "upstream_mcp",
				connectorType: "MCP",
				mcpEndpointNormalized: "https://disabled.example/mcp",
				protocolVersion: "2026-07-28",
				healthStatus: "healthy",
				healthData: { lastCheckedAt: freshCheckedAt },
				mcpMetadata: { protocolObservedAt: freshCheckedAt },
				status: "DISABLED",
				createdAt: STAMP,
				updatedAt: STAMP,
			},
		];
		for (const row of rows) {
			await db.insert(appCatalog).values({ ...row, lastSyncedAt: STAMP });
		}

		const summary = await getCatalogHealthSummary(db);
		expect(summary.protocolInventory).toEqual({
			modern2026: 2,
			legacyStreamable: 1,
			legacySse: 1,
			unknown: 1,
			freshWithin24h: {
				modern2026: 2,
				legacyStreamable: 1,
				legacySse: 0,
				unknown: 0,
			},
			staleOrUnscanned: 2,
			enabled: {
				total: 4,
				modern2026: 1,
				legacyStreamable: 1,
				legacySse: 1,
				unknown: 1,
				freshWithin24h: {
					modern2026: 1,
					legacyStreamable: 1,
					legacySse: 0,
					unknown: 0,
				},
				staleOrUnscanned: 2,
			},
			tedixOwned: {
				total: 1,
				modern2026: 1,
				legacyStreamable: 0,
				legacySse: 0,
				unknown: 0,
				freshWithin24h: {
					modern2026: 1,
					legacyStreamable: 0,
					legacySse: 0,
					unknown: 0,
				},
				staleOrUnscanned: 0,
				apps: [
					{
						slug: "modern",
						endpoint: "https://modern.mcp.tedix.dev/mcp",
						protocolVersion: "2026-07-28",
						protocolEra: "modern_2026",
						healthStatus: "healthy",
						protocolObservedAt: freshCheckedAt,
					},
				],
				appsTruncated: false,
			},
			legacyApps: [
				{
					slug: "legacy-streamable",
					protocolVersion: "2025-03-26",
					protocolEra: "legacy_streamable_2025",
					healthStatus: "degraded",
					protocolObservedAt: freshCheckedAt,
				},
				{
					slug: "legacy-sse",
					protocolVersion: "2024-11-05",
					protocolEra: "legacy_sse_2024",
					healthStatus: "healthy",
					protocolObservedAt: "2026-08-22T12:00:00.000Z",
				},
			],
			legacyAppsTruncated: false,
		});
	});
});
