import { DatabaseSync } from "node:sqlite";
import { eq } from "drizzle-orm";
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vite-plus/test";
import { createDbClient } from "../../client";
import { apps } from "../../schema/apps";
import {
	appCatalog,
	appCatalogMcpPrompts,
	appCatalogMcpResources,
	appCatalogMcpResourceTemplates,
	appCatalogMcpTools,
	appCatalogStoreListings,
	upstreamDriftReports,
} from "../../schema/catalog";
import { appTools } from "../../schema/tools";
import { createD1Facade } from "../../test/d1-facade";
import { schemaDdl } from "../../test/schema-ddl";
import {
	buildCatalogQualityReport,
	runCatalogDriftDetection,
	runCatalogIntegrityMaintenance,
} from "./maintenance-reports";
import { syncCatalogToolsToApp } from "./sync-tools-to-app";
import type { ToolDriftReportItem } from "./tool-source-policy";
import { checkUpstreamDrift } from "./upstream-drift";

// Keep persistence real; replace the upstream probe and external app synchronization.
vi.mock("./upstream-drift", () => ({ checkUpstreamDrift: vi.fn() }));
vi.mock("./sync-tools-to-app", () => ({ syncCatalogToolsToApp: vi.fn() }));

const NOW = "2026-10-20T12:00:00.000Z";
const databases: DatabaseSync[] = [];

afterEach(() => {
	for (const sqlite of databases.splice(0)) sqlite.close();
});

beforeEach(() => {
	vi.resetAllMocks();
	vi.mocked(checkUpstreamDrift).mockResolvedValue({
		addedTools: 0,
		removedTools: 0,
		changedTools: 0,
		drifts: [],
	});
});

function setup() {
	const sqlite = new DatabaseSync(":memory:");
	databases.push(sqlite);
	sqlite.exec("PRAGMA foreign_keys = OFF");
	sqlite.exec(
		schemaDdl(
			appCatalog,
			appCatalogMcpTools,
			appCatalogMcpResources,
			appCatalogMcpResourceTemplates,
			appCatalogMcpPrompts,
			appCatalogStoreListings,
			apps,
			appTools,
			upstreamDriftReports,
		),
	);
	// Pin SQLite's clock; JavaScript fake timers do not affect SQL now.
	const d1 = createD1Facade(
		{
			prepare: (query) => sqlite.prepare(query.replaceAll("'now'", `'${NOW}'`)),
			exec: (query) => sqlite.exec(query),
		},
		{ maxBoundParams: 100 },
	);
	return { sqlite, d1, db: createDbClient(d1) };
}

type Db = ReturnType<typeof setup>["db"];

async function seedCatalog(
	db: Db,
	id: string,
	values: Partial<typeof appCatalog.$inferInsert> = {},
) {
	await db.insert(appCatalog).values({
		id,
		name: id,
		slug: id,
		connectorType: "MCP",
		status: "ENABLED",
		description:
			"A fictional catalog application with a complete public description for testing maintenance reports.",
		logoUrl: `https://assets.example.test/app_catalog/${id}.png`,
		richContent: {
			screenshotUrl: "https://assets.example.test/screenshot.png",
		},
		lastSyncedAt: NOW,
		...values,
	});
	await db.insert(appCatalogStoreListings).values({
		id: `listing-${id}`,
		catalogAppId: id,
		source: "chatgpt",
		sourceAppId: id,
		lastSyncedAt: NOW,
	});
}

describe("buildCatalogQualityReport stale boundary", () => {
	it.each([
		["tool", appCatalogMcpTools, { toolName: "list_entries" }],
		["resource", appCatalogMcpResources, { uri: "test://entries" }],
		[
			"resource_template",
			appCatalogMcpResourceTemplates,
			{ name: "entries", uriTemplate: "test://entries/{id}" },
		],
		["prompt", appCatalogMcpPrompts, { promptName: "summarize_entries" }],
	] as const)(
		"counts only active %s rows strictly older than the cutoff",
		async (entity, table, fields) => {
			const { db, d1 } = setup();
			await seedCatalog(db, "fictional-boundary");
			for (const [id, lastSeenAt, removedAt] of [
				["exact", "2026-10-06T12:00:00.000Z", null],
				["past", "2026-10-06T11:59:59.999Z", null],
				["recent", "2026-10-06T12:00:00.001Z", null],
				["removed", "2026-10-01T00:00:00.000Z", NOW],
			]) {
				await db.insert(table).values({
					id,
					catalogAppId: "fictional-boundary",
					detectedAt: NOW,
					lastSeenAt,
					removedAt,
					...Object.fromEntries(
						Object.entries(fields).map(([key, value]) => [
							key,
							`${value}-${id}`,
						]),
					),
				});
			}
			const report = await buildCatalogQualityReport(d1, {
				staleLastSeenDays: 14,
			});
			expect(report.issues).toEqual([
				expect.objectContaining({
					code: "stale_last_seen",
					severity: "warning",
					count: 1,
					summary: `fictional-boundary has 1 active ${entity} row(s) not seen in 14+ day(s).`,
					details: {
						entity,
						staleLastSeenDays: 14,
						oldestLastSeenAt: "2026-10-06T11:59:59.999Z",
						newestLastSeenAt: "2026-10-06T11:59:59.999Z",
					},
				}),
			]);
			expect(report.summary).toBe(
				"1 catalog quality issue(s): 0 error(s), 1 warning(s).",
			);
		},
	);
});

describe("buildCatalogQualityReport", () => {
	it("reports every quality code once with exact severity, counts and summaries without writes", async () => {
		const { db, d1, sqlite } = setup();
		await seedCatalog(db, "missing-name", { name: "  " });
		await seedCatalog(db, "missing-slug", { slug: " " });
		await seedCatalog(db, "missing-logo", { logoUrl: null, richContent: null });
		await seedCatalog(db, "missing-description", { description: " " });
		await seedCatalog(db, "weak-description", { description: "Thin." });
		await seedCatalog(db, "missing-source");
		await db
			.update(appCatalogStoreListings)
			.set({ sourceAppId: " " })
			.where(eq(appCatalogStoreListings.catalogAppId, "missing-source"));
		await seedCatalog(db, "leak", { baseUrl: "http://localhost/rpc/tools" });
		await seedCatalog(db, "duplicate-a", { slug: "Fictional.Entry" });
		await seedCatalog(db, "duplicate-b", { slug: "fictional_entry" });
		await seedCatalog(db, "stale");
		await db.insert(appCatalogMcpTools).values({
			id: "stale-tool",
			catalogAppId: "stale",
			toolName: "list_entries",
			detectedAt: NOW,
			lastSeenAt: "2026-09-01T00:00:00.000Z",
		});
		await seedCatalog(db, "disabled", {
			status: "DISABLED",
			name: "",
			slug: "",
			description: "",
			logoUrl: null,
		});
		const before = sqlite.prepare("SELECT total_changes() AS changes").get();
		const report = await buildCatalogQualityReport(d1);
		expect(sqlite.prepare("SELECT total_changes() AS changes").get()).toEqual(
			before,
		);
		expect(report).toMatchObject({
			catalogAppId: null,
			staleLastSeenDays: 14,
			issueCount: 10,
			errorCount: 2,
			warningCount: 8,
			summary: "10 catalog quality issue(s): 2 error(s), 8 warning(s).",
		});
		expect(Number.isNaN(Date.parse(report.checkedAt))).toBe(false);
		expect(
			report.issues.map(({ code, severity, count, summary }) => ({
				code,
				severity,
				count,
				summary,
			})),
		).toEqual([
			{
				code: "missing_name",
				severity: "error",
				count: 1,
				summary: "missing-name has no usable catalog name.",
			},
			{
				code: "missing_description",
				severity: "warning",
				count: 1,
				summary: "missing-description has no catalog description.",
			},
			{
				code: "missing_logo",
				severity: "warning",
				count: 1,
				summary: "missing-logo has no catalog logo URL.",
			},
			{
				code: "missing_slug",
				severity: "warning",
				count: 1,
				summary: "  has no catalog slug.",
			},
			{
				code: "asset_backfill_candidate",
				severity: "warning",
				count: 2,
				summary:
					"missing-logo should be queued for public asset normalization (logo, screenshot).",
			},
			{
				code: "weak_description",
				severity: "warning",
				count: 1,
				summary: "weak-description has a thin public description (5 chars).",
			},
			{
				code: "missing_source_id",
				severity: "error",
				count: 1,
				summary:
					"missing-source has 1 store listing(s) with a blank sourceAppId.",
			},
			{
				code: "tenant_proxy_or_internal_leakage",
				severity: "warning",
				count: 1,
				summary:
					"leak exposes a Tedix/internal-looking URL in catalog metadata.",
			},
			{
				code: "duplicateish_slug",
				severity: "warning",
				count: 2,
				summary: '2 catalog apps normalize to slug "fictional-entry".',
			},
			{
				code: "stale_last_seen",
				severity: "warning",
				count: 1,
				summary: "stale has 1 active tool row(s) not seen in 14+ day(s).",
			},
		]);
		expect(
			report.issues.find((issue) => issue.code === "asset_backfill_candidate")
				?.details,
		).toMatchObject({ targets: ["logo", "screenshot"], hasSvgLogo: false });
	});

	it("scopes ordinary issues and duplicate groups to catalogAppId", async () => {
		const { db, d1 } = setup();
		await seedCatalog(db, "chosen", {
			description: "Short",
			slug: "same.slug",
		});
		await seedCatalog(db, "sibling", {
			description: "Other",
			slug: "same_slug",
		});
		await seedCatalog(db, "unrelated", { name: "" });
		const report = await buildCatalogQualityReport(d1, {
			catalogAppId: "chosen",
		});
		expect(report).toMatchObject({ catalogAppId: "chosen", issueCount: 2 });
		expect(report.issues.map((issue) => issue.code)).toEqual([
			"weak_description",
			"duplicateish_slug",
		]);
		expect(report.issues[0]?.catalogAppId).toBe("chosen");
		expect(report.issues[1]).toMatchObject({
			catalogAppId: null,
			count: 2,
			details: { catalogAppIds: ["chosen", "sibling"] },
		});
		expect(
			(await buildCatalogQualityReport(d1, { catalogAppId: "absent" })).issues,
		).toEqual([]);
	});

	it("distinguishes missing listings from blank IDs and proxy tools from public proxies", async () => {
		const { db, d1 } = setup();
		await seedCatalog(db, "fictional-proxy");
		await db.delete(appCatalogStoreListings);
		await db.insert(apps).values({
			id: "proxy",
			organizationId: "org-fictional",
			name: "Fictional proxy",
			slug: "fictional-proxy",
			catalogAppId: "fictional-proxy",
			sourceAppId: "base",
			visibility: "public",
		});
		await db.insert(appTools).values({
			id: "proxy-tool",
			appId: "proxy",
			toolId: "list_entries",
			title: "List entries",
			toolTypeId: "mcp",
		});
		const report = await buildCatalogQualityReport(d1);
		expect(report).toMatchObject({
			issueCount: 3,
			errorCount: 1,
			warningCount: 2,
		});
		expect(report.issues).toEqual([
			expect.objectContaining({
				code: "missing_source_id",
				severity: "warning",
				count: 1,
				summary: "fictional-proxy has no store listing source ID rows.",
			}),
			expect.objectContaining({
				code: "tenant_proxy_or_internal_leakage",
				severity: "error",
				count: 1,
				summary:
					"fictional-proxy is a tenant proxy app with 1 direct tool row(s).",
			}),
			expect.objectContaining({
				code: "tenant_proxy_or_internal_leakage",
				severity: "warning",
				count: 1,
				summary: "fictional-proxy is a tenant proxy app marked public.",
			}),
		]);
	});

	it.each([
		["data:image/png;base64,AA", null, true],
		["connectors://fictional", null, true],
		["https://google.com/s2/favicons?domain=example.test", null, true],
		["/relative/logo.png", null, true],
		["https://example.test/logo.png", null, true],
		["https://example.test/app_catalog/logo.png", "fetch_failed", true],
		["https://example.test/app_catalog/logo.png", null, false],
		["https://example.test/app_catalog%2Flogo.png", null, false],
	] as const)(
		"classifies logo %s with status %s",
		async (logoUrl, logoStatus, expected) => {
			const { db, d1 } = setup();
			await seedCatalog(db, "fictional-asset", {
				logoUrl,
				rawData: { quality: { logoStatus } },
			});
			const report = await buildCatalogQualityReport(d1);
			expect(report.issues.map((issue) => issue.code)).toEqual(
				expected ? ["asset_backfill_candidate"] : [],
			);
			if (expected)
				expect(report.issues[0]).toMatchObject({
					count: 1,
					details: { targets: ["logo"] },
				});
		},
	);

	it.each([
		[0, 1],
		[400, 365],
	] as const)("clamps staleLastSeenDays %s to %s", async (input, expected) => {
		const { db, d1 } = setup();
		await seedCatalog(db, "fictional-stale");
		await db.insert(appCatalogMcpTools).values({
			id: "old",
			catalogAppId: "fictional-stale",
			toolName: "list_entries",
			detectedAt: NOW,
			lastSeenAt: "2020-01-01T00:00:00.000Z",
		});
		const report = await buildCatalogQualityReport(d1, {
			staleLastSeenDays: input,
		});
		expect(report.staleLastSeenDays).toBe(expected);
		expect(report.issues[0]?.details?.staleLastSeenDays).toBe(expected);
	});

	it("caps quality results at 200 and scans over 100 apps within the D1 parameter ceiling", async () => {
		const { db, d1 } = setup();
		for (let index = 0; index < 205; index++)
			await seedCatalog(db, `fictional-${index}`, { name: "" });
		const report = await buildCatalogQualityReport(d1);
		expect(report).toMatchObject({
			issueCount: 200,
			errorCount: 200,
			warningCount: 0,
		});
		const integrity = await runCatalogIntegrityMaintenance(db, d1, {
			apply: false,
		});
		expect(integrity.checkedApps).toBe(205);
	});
});

describe("runCatalogIntegrityMaintenance", () => {
	async function fixture() {
		const state = setup();
		await seedCatalog(state.db, "a-fictional-repair", {
			mcpToolCount: 7,
			baseUrl: "https://api.example.test/mcp",
			description: "Short",
		});
		await seedCatalog(state.db, "b-fictional-other", { mcpToolCount: 9 });
		await state.db.insert(appCatalogMcpTools).values({
			id: "repair-tool",
			catalogAppId: "a-fictional-repair",
			toolName: "list_entries",
			description: "Preserve description",
			inputSchema: { type: "object", properties: {} },
			detectedAt: NOW,
			lastSeenAt: NOW,
		});
		await state.db.insert(apps).values({
			id: "base",
			name: "Fictional base",
			slug: "fictional-base",
			organizationId: "org-fictional",
			catalogAppId: "a-fictional-repair",
		});
		await state.db.insert(appTools).values({
			id: "undeclared",
			appId: "base",
			toolId: "list_entries",
			title: "List entries",
			toolTypeId: "mcp",
		});
		return state;
	}

	it("apply:false writes nothing while composing integrity, quality and write-capability reports", async () => {
		const { db, d1, sqlite } = await fixture();
		const before = sqlite.prepare("SELECT total_changes() AS changes").get();
		const report = await runCatalogIntegrityMaintenance(db, d1, {
			apply: false,
			catalogAppId: "a-fictional-repair",
		});
		expect(sqlite.prepare("SELECT total_changes() AS changes").get()).toEqual(
			before,
		);
		expect(report).toMatchObject({
			apply: false,
			checkedApps: 1,
			errorCount: 1,
			warningCount: 1,
			repaired: { provenanceRows: 0, toolCounts: 0 },
			qualityReport: { issueCount: 1 },
			writeCapabilityReport: { totalTools: 1, totalApps: 1 },
		});
		expect(report.issues.map((issue) => issue.code)).toEqual([
			"tool_count_mismatch",
			"missing_schema_provenance",
		]);
		expect(report.summary).toBe(
			`1 catalog app(s) checked: 1 error(s), 1 warning(s). Repaired 0 provenance row(s) and 0 tool count(s). ${report.qualityReport.summary} ${report.writeCapabilityReport.summary}`,
		);
	});

	it.each([true, undefined])(
		"apply:%s repairs only provenance and tool count, preserving advisory issues and other apps",
		async (apply) => {
			const { db, d1 } = await fixture();
			const beforeTools = await db.select().from(appTools);
			const [beforeCatalog] = await db
				.select()
				.from(appCatalog)
				.where(eq(appCatalog.id, "a-fictional-repair"));
			const [beforeSnapshot] = await db.select().from(appCatalogMcpTools);
			const [beforeOther] = await db
				.select()
				.from(appCatalog)
				.where(eq(appCatalog.id, "b-fictional-other"));
			const report = await runCatalogIntegrityMaintenance(db, d1, {
				apply,
				catalogAppId: "a-fictional-repair",
			});
			expect(report).toMatchObject({
				apply: true,
				checkedApps: 1,
				issueCount: 0,
				repaired: { provenanceRows: 1, toolCounts: 1 },
				qualityReport: { issueCount: 1 },
				writeCapabilityReport: { totalTools: 1 },
			});
			const [catalog] = await db
				.select()
				.from(appCatalog)
				.where(eq(appCatalog.id, "a-fictional-repair"));
			expect(catalog).toEqual({
				...beforeCatalog,
				mcpToolCount: 1,
				updatedAt: "2026-10-20 12:00:00",
			});
			const [snapshot] = await db.select().from(appCatalogMcpTools);
			expect(snapshot).toEqual({
				...beforeSnapshot,
				schemaDialect: "json-schema-2020-12",
				schemaSource: "mcp",
				schemaSourceRef: expect.any(String),
				schemaSourceHash: expect.any(String),
				schemaSyncedAt: expect.any(String),
			});
			expect(await db.select().from(appTools)).toEqual(beforeTools);
			expect(
				await db
					.select()
					.from(appCatalog)
					.where(eq(appCatalog.id, "b-fictional-other")),
			).toEqual([beforeOther]);
			const repeated = await runCatalogIntegrityMaintenance(db, d1, {
				apply: true,
				catalogAppId: "a-fictional-repair",
			});
			expect(repeated.repaired).toEqual({ provenanceRows: 0, toolCounts: 0 });
		},
	);

	it("limit narrows integrity scanning and count repairs", async () => {
		const { db, d1 } = setup();
		await seedCatalog(db, "a-fictional", { mcpToolCount: 3 });
		await seedCatalog(db, "b-fictional", { mcpToolCount: 4 });
		const report = await runCatalogIntegrityMaintenance(db, d1, {
			apply: true,
			limit: 1,
		});
		expect(report).toMatchObject({
			checkedApps: 1,
			repaired: { toolCounts: 1 },
		});
		expect(
			await db
				.select({ id: appCatalog.id, count: appCatalog.mcpToolCount })
				.from(appCatalog)
				.orderBy(appCatalog.id),
		).toEqual([
			{ id: "a-fictional", count: 0 },
			{ id: "b-fictional", count: 4 },
		]);
	});
});

describe("runCatalogDriftDetection", () => {
	async function seedCandidate(
		db: Db,
		id: string,
		values: Partial<typeof appCatalog.$inferInsert> = {},
	) {
		await seedCatalog(db, id, {
			mcpEndpointNormalized: `https://${id}.example.test/mcp`,
			healthStatus: "healthy",
			...values,
		});
	}
	async function seedBase(db: Db, catalogAppId: string, id = "base") {
		await db.insert(apps).values({
			id,
			catalogAppId,
			name: `Fictional ${id}`,
			slug: id,
			organizationId: "org-fictional",
		});
	}
	function drift(driftType: ToolDriftReportItem["driftType"]) {
		return {
			addedTools: 0,
			removedTools: 0,
			changedTools: 1,
			drifts: [{ toolName: "list_entries", driftType }],
		};
	}

	it.each([
		"schema_changed",
		"description_changed",
		"metadata_changed",
		"new_upstream",
		"removed_upstream",
	] as const)(
		"saves and resolves %s after syncing an eligible base app",
		async (driftType) => {
			const { db, d1 } = setup();
			await seedCandidate(db, "fictional-drift");
			await seedBase(db, "fictional-drift");
			vi.mocked(checkUpstreamDrift).mockResolvedValue(drift(driftType));
			const report = await runCatalogDriftDetection(db, d1);
			expect(report).toEqual({
				checked: 1,
				candidates: 1,
				reportsSaved: 1,
				totalDrifts: 1,
				autoSyncs: 1,
				failures: [],
				summary:
					"Checked 1 catalog app(s): 1 drift report(s), 1 drift item(s), 1 auto-sync(s), 0 failure(s).",
			});
			expect(syncCatalogToolsToApp).toHaveBeenCalledExactlyOnceWith(db, {
				catalogAppId: "fictional-drift",
				appId: "base",
				mcpServerUrl: "https://fictional-drift.example.test/mcp",
				connectionProviderId: undefined,
				connectionScope: "tenant",
				dryRun: false,
				disableRemoved: true,
			});
			const [saved] = await db.select().from(upstreamDriftReports);
			expect(saved).toMatchObject({
				catalogAppId: "fictional-drift",
				changedTools: 1,
				drifts: drift(driftType).drifts,
				summary: "Drift detected for fictional-drift: 1 changed",
				resolvedAt: expect.any(String),
			});
		},
	);

	it("keeps manual reports unresolved when autoSync is false or a drift type is unrecognized", async () => {
		const { db, d1 } = setup();
		await seedCandidate(db, "fictional-manual");
		await seedBase(db, "fictional-manual");
		vi.mocked(checkUpstreamDrift).mockResolvedValue(drift("schema_changed"));
		const disabled = await runCatalogDriftDetection(db, d1, {
			autoSync: false,
		});
		expect(disabled).toMatchObject({
			reportsSaved: 1,
			totalDrifts: 1,
			autoSyncs: 0,
		});
		// An unrecognized future upstream value must stay manual at this boundary.
		vi.mocked(checkUpstreamDrift).mockResolvedValue(
			drift("manual_review" as ToolDriftReportItem["driftType"]),
		);
		const manual = await runCatalogDriftDetection(db, d1);
		expect(manual).toMatchObject({ reportsSaved: 1, autoSyncs: 0 });
		expect(syncCatalogToolsToApp).not.toHaveBeenCalled();
		expect(await db.select().from(upstreamDriftReports)).toEqual([
			expect.objectContaining({ resolvedAt: null }),
		]);
	});

	it("honors per-base-app opt-out and connection policy, excluding tenant proxies", async () => {
		const { db, d1, sqlite } = setup();
		await seedCandidate(db, "fictional-policy");
		await seedBase(db, "fictional-policy", "opted-out");
		await seedBase(db, "fictional-policy", "opted-in");
		sqlite
			.prepare("UPDATE apps SET metadata = ? WHERE id = ?")
			.run(JSON.stringify({ mcpConfig: { autoSync: false } }), "opted-out");
		sqlite.prepare("UPDATE apps SET metadata = ? WHERE id = ?").run(
			JSON.stringify({
				mcpConfig: {
					connectionProviderId: "fictional-provider",
					connectionScope: "user",
				},
			}),
			"opted-in",
		);
		await db.insert(apps).values({
			id: "proxy",
			name: "Fictional proxy",
			slug: "proxy",
			organizationId: "org-fictional",
			catalogAppId: "fictional-policy",
			sourceAppId: "opted-in",
		});
		vi.mocked(checkUpstreamDrift).mockResolvedValue(drift("metadata_changed"));
		expect(await runCatalogDriftDetection(db, d1)).toMatchObject({
			autoSyncs: 1,
		});
		expect(syncCatalogToolsToApp).toHaveBeenCalledExactlyOnceWith(
			db,
			expect.objectContaining({
				appId: "opted-in",
				connectionProviderId: "fictional-provider",
				connectionScope: "user",
			}),
		);
	});

	it.each(["{broken", "[]", "null", "42"])(
		"defaults malformed or non-object metadata %s to tenant sync",
		async (metadata) => {
			const { db, d1, sqlite } = setup();
			await seedCandidate(db, "fictional-default");
			await seedBase(db, "fictional-default");
			sqlite.prepare("UPDATE apps SET metadata = ?").run(metadata);
			vi.mocked(checkUpstreamDrift).mockResolvedValue(drift("new_upstream"));
			expect(await runCatalogDriftDetection(db, d1)).toMatchObject({
				autoSyncs: 1,
			});
			expect(syncCatalogToolsToApp).toHaveBeenCalledWith(
				db,
				expect.objectContaining({
					connectionScope: "tenant",
					connectionProviderId: undefined,
				}),
			);
		},
	);

	it("prioritizes base apps, applies limit and catalogAppId, and skips disabled, endpointless and auth-required upstreams", async () => {
		const { db, d1 } = setup();
		await seedCandidate(db, "a-without-base");
		await seedCandidate(db, "z-with-base", { healthStatus: "degraded" });
		await seedBase(db, "z-with-base");
		await seedCandidate(db, "disabled", { status: "DISABLED" });
		await seedCatalog(db, "endpointless");
		await seedCandidate(db, "requires-auth", { healthStatus: "requires_auth" });
		expect(await runCatalogDriftDetection(db, d1, { limit: 1 })).toMatchObject({
			checked: 1,
			candidates: 1,
		});
		expect(checkUpstreamDrift).toHaveBeenCalledExactlyOnceWith(
			db,
			"z-with-base",
		);
		vi.mocked(checkUpstreamDrift).mockClear();
		expect(
			await runCatalogDriftDetection(db, d1, {
				catalogAppId: "a-without-base",
			}),
		).toMatchObject({ checked: 1, candidates: 1 });
		expect(checkUpstreamDrift).toHaveBeenCalledExactlyOnceWith(
			db,
			"a-without-base",
		);
		vi.mocked(checkUpstreamDrift).mockClear();
		expect(await runCatalogDriftDetection(db, d1)).toMatchObject({
			checked: 2,
			candidates: 3,
			reportsSaved: 0,
		});
		expect(checkUpstreamDrift).toHaveBeenCalledTimes(2);
		expect(await db.select().from(upstreamDriftReports)).toEqual([]);
	});

	it("checks auth-required generated apps and leaves reports manual without a base app", async () => {
		const { db, d1 } = setup();
		await seedCandidate(db, "fictional-generated", {
			healthStatus: "requires_auth",
			toolSource: "openapi",
		});
		vi.mocked(checkUpstreamDrift).mockResolvedValue(drift("schema_changed"));
		expect(await runCatalogDriftDetection(db, d1)).toMatchObject({
			checked: 1,
			reportsSaved: 1,
			autoSyncs: 0,
		});
		expect(syncCatalogToolsToApp).not.toHaveBeenCalled();
	});

	it("records failures per app and continues, preserving an unresolved report after sync failure", async () => {
		const { db, d1 } = setup();
		await seedCandidate(db, "a-probe-failure");
		await seedCandidate(db, "b-sync-failure");
		await seedBase(db, "b-sync-failure");
		await seedCandidate(db, "c-success");
		vi.mocked(checkUpstreamDrift).mockImplementation(async (_db, id) => {
			if (id === "a-probe-failure") throw new Error("Fictional probe failed");
			return {
				addedTools: 1,
				removedTools: 1,
				changedTools: 1,
				drifts: drift("new_upstream").drifts,
			};
		});
		vi.mocked(syncCatalogToolsToApp).mockRejectedValue("Fictional sync failed");
		const report = await runCatalogDriftDetection(db, d1);
		expect(report).toMatchObject({
			checked: 3,
			reportsSaved: 2,
			totalDrifts: 2,
			autoSyncs: 0,
			failures: [
				{
					catalogAppId: "b-sync-failure",
					name: "b-sync-failure",
					error: "Fictional sync failed",
				},
				{
					catalogAppId: "a-probe-failure",
					name: "a-probe-failure",
					error: "Fictional probe failed",
				},
			],
		});
		expect(await db.select().from(upstreamDriftReports)).toEqual([
			expect.objectContaining({
				catalogAppId: "b-sync-failure",
				resolvedAt: null,
				summary:
					"Drift detected for b-sync-failure: 1 added, 1 removed, 1 changed",
			}),
			expect.objectContaining({ catalogAppId: "c-success", resolvedAt: null }),
		]);
	});
});
