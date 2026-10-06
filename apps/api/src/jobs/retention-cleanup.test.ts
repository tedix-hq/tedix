import { DatabaseSync } from "node:sqlite";
import { tediCallCosts } from "@tedix/db/schema/tedis";
import { appCatalogHealthHistory } from "@tedix/db/schema/catalog";
import { kernelToolResults } from "@tedix/db/schema/cognitive-runtime";
import { organizations } from "@tedix/db/schema/organizations";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	formatWorkGraphStewardSummary,
	runRetentionCleanupCron,
} from "./retention-cleanup";

describe("retention cleanup work-graph logging", () => {
	it("logs canonical idle-spec and expired-attempt observations", () => {
		expect(
			formatWorkGraphStewardSummary({
				orgs: 3,
				duplicateLinks: 2,
				flags: 4,
				idleAccepted: 7,
				expiredAttempts: 1,
				errors: 0,
			}),
		).toBe(
			"[Scheduled] Work-graph steward: orgs=3 dupLinks=2 flags=4 idleAccepted=7 expiredAttempts=1 errors=0",
		);
	});
});

// Keep real D1 cost storage and one operational expiry as the behavioral control.
vi.mock("@tedix/db/queries/catalog/maintenance", async (importOriginal) => {
	const actual =
		await importOriginal<
			typeof import("@tedix/db/queries/catalog/maintenance")
		>();
	return {
		...actual,
		deleteOldCatalogChanges: vi.fn().mockResolvedValue(0),
		deleteOldToolTests: vi.fn().mockResolvedValue(0),
		deleteOldAuditEvents: vi.fn().mockResolvedValue(0),
		deleteOldTediRuntimeEvents: vi.fn().mockResolvedValue(0),
		deleteOldKernelRuntimeEvents: vi.fn().mockResolvedValue(0),
		deleteOldCronExecutions: vi.fn().mockResolvedValue(0),
		deleteOldSkillUsageEvents: vi.fn().mockResolvedValue(0),
		deleteOldRuntimeSubmissions: vi.fn().mockResolvedValue(0),
		deleteOldLearningInteractionEvents: vi.fn().mockResolvedValue(0),
		deleteOldHarnessEvalResults: vi.fn().mockResolvedValue(0),
		deleteOldHarnessEvalRuns: vi.fn().mockResolvedValue(0),
		deleteOldTraceBundles: vi.fn().mockResolvedValue(0),
	};
});
vi.mock("@tedix/db/queries/jobs", () => ({
	cleanupOldJobs: vi.fn().mockResolvedValue(0),
}));
vi.mock("@tedix/db/queries/tedis", () => ({
	cleanupOldSnapshots: vi.fn().mockResolvedValue(0),
	cleanupOldUsageEvents: vi.fn().mockResolvedValue(0),
}));
vi.mock("@tedix/db/queries/platform-cron-executions", () => ({
	PLATFORM_CRON_RECEIPT_RETENTION_DAYS: 90,
	prunePlatformCronExecutions: vi.fn().mockResolvedValue(0),
}));
vi.mock("@tedix/db/queries/catalog/create-base-app", () => ({
	backfillCatalogBaseAppAutoSync: vi.fn().mockResolvedValue(0),
}));
vi.mock("@tedix/db/queries/analytics", () => ({
	deleteOldWidgetEvents: vi.fn().mockResolvedValue(0),
}));
vi.mock("@tedix/db/queries/workflow-runs", () => ({
	deleteOldWorkflowRunRecords: vi.fn().mockResolvedValue(0),
}));
vi.mock("@tedix/db/queries/graph-projection", () => ({
	pruneAcknowledgedGraphProjectionEvents: vi.fn().mockResolvedValue(0),
}));
vi.mock("@tedix/db/queries/catalog/drift-reports", () => ({
	deleteOldDriftReports: vi.fn().mockResolvedValue(0),
}));
vi.mock("@tedix/db/queries/catalog/scheduled-maintenance", () => ({
	getCatalogEnrichmentHealth: vi
		.fn()
		.mockResolvedValue({ needsEnrichment: 0, totalMcp: 0 }),
	getStaleUnhealthyAppCount: vi.fn().mockResolvedValue(0),
	autoDisableDeadMcpCatalogApps: vi.fn().mockResolvedValue({ disabled: 0 }),
	autoHideUnhealthyCatalogApps: vi.fn().mockResolvedValue(0),
	autoDelistStaleCatalogApps: vi.fn().mockResolvedValue(0),
}));
vi.mock("@tedix/db/queries/rationale-records", () => ({
	closeStalePendingRationaleRecords: vi.fn().mockResolvedValue(0),
}));
vi.mock("@tedix/db/queries/skill-lifecycle", () => ({
	sweepExpiredDraftSkills: vi
		.fn()
		.mockResolvedValue({ archived: 0, entries: [] }),
}));
vi.mock("@tedix/db/queries/fact-lifecycle", () => ({
	FACT_TTL_SWEEP_HOMEOSTAT_MAX_BATCHES_PER_ORG: 10,
	sweepExpiredProbationFacts: vi.fn().mockResolvedValue({ archivedIds: [] }),
}));
vi.mock("@tedix/db/queries/flywheel/cron-darkness", () => ({
	findDarkCognitiveCrons: vi.fn().mockResolvedValue([]),
	upsertCronDarknessWorkItems: vi
		.fn()
		.mockResolvedValue({ sourceIntentIds: [] }),
}));
vi.mock("@tedix/db/queries/work-graph-steward", () => ({
	listOrgIdsWithOpenWorkItems: vi.fn().mockResolvedValue([]),
	runWorkGraphSteward: vi.fn().mockResolvedValue({}),
}));
vi.mock("../rpc/routers/catalog", () => ({
	fetchClaudeRegistry: vi.fn().mockResolvedValue({ servers: [], error: null }),
}));
afterEach(() => vi.restoreAllMocks());

describe("scheduled usage evidence retention", () => {
	it("retains aged unpriced, failed and priced calls while expiring operational health history", async () => {
		const sqlite = new DatabaseSync(":memory:");
		try {
			sqlite.exec("PRAGMA foreign_keys = OFF;");
			sqlite.exec(
				schemaDdl(
					organizations,
					kernelToolResults,
					tediCallCosts,
					appCatalogHealthHistory,
				),
			);
			const old = new Date(Date.now() - 60 * 86_400_000).toISOString();
			const recent = new Date().toISOString();
			for (const quality of [
				"ok",
				"quarantined_no_pricing",
				"quarantined_failed",
			]) {
				for (const [age, timestamp] of [
					["old", old],
					["recent", recent],
				]) {
					const id = `${quality}-${age}`;
					sqlite
						.prepare(
							`INSERT INTO tedi_call_costs (id, gateway_log_id, gateway_id, snapshot_at, created_at, model, provider, input_tokens, output_tokens, total_tokens, estimated_cost_usd, success, data_quality) VALUES (?, ?, 'gateway', ?, ?, 'unresolved-model', 'azure-openai', 100, 20, 120, ?, ?, ?)`,
						)
						.run(
							id,
							id,
							timestamp,
							timestamp,
							quality === "ok" ? 0.5 : 0,
							quality === "quarantined_failed" ? 0 : 1,
							quality,
						);
				}
			}
			for (const [id, timestamp] of [
				["old", old],
				["recent", recent],
			]) {
				sqlite
					.prepare(
						"INSERT INTO app_catalog_health_history (id, catalog_app_id, checked_at, status) VALUES (?, 'app', ?, 'healthy')",
					)
					.run(id, timestamp);
			}
			const before = sqlite
				.prepare("SELECT * FROM tedi_call_costs ORDER BY id")
				.all();
			const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
			const error = vi.spyOn(console, "error").mockImplementation(() => {});
			vi.spyOn(console, "log").mockImplementation(() => {});
			const env = {
				DB: createD1Facade(sqlite),
				CATALOG_INTEGRITY_WORKFLOW: {
					create: vi.fn().mockResolvedValue({ id: "integrity" }),
				},
			} as unknown as CloudflareEnv;
			const result = await runRetentionCleanupCron(
				env,
				{
					scheduledTime: Date.parse("2026-09-21T03:00:00Z"),
				} as ScheduledController,
				"retention-test",
			);
			expect(
				sqlite
					.prepare("SELECT id FROM app_catalog_health_history ORDER BY id")
					.all(),
			).toEqual([{ id: "recent" }]);
			expect(result.healthHistoryDeleted).toBe(1);
			expect(warn).not.toHaveBeenCalled();
			expect(error).not.toHaveBeenCalled();
			expect(
				sqlite.prepare("SELECT * FROM tedi_call_costs ORDER BY id").all(),
			).toEqual(before);
		} finally {
			sqlite.close();
		}
	});
});

it("logs 3am maintenance failures without returned or thrown text", async () => {
	const sqlite = new DatabaseSync(":memory:");
	try {
		sqlite.exec("PRAGMA foreign_keys = OFF;");
		sqlite.exec(
			schemaDdl(
				organizations,
				kernelToolResults,
				tediCallCosts,
				appCatalogHealthHistory,
			),
		);
		const { backfillCatalogBaseAppAutoSync } =
			await import("@tedix/db/queries/catalog/create-base-app");
		vi.mocked(backfillCatalogBaseAppAutoSync).mockRejectedValueOnce(
			new TypeError("SQL token=secret-backfill"),
		);
		const { listOrgIdsWithOpenWorkItems, runWorkGraphSteward } =
			await import("@tedix/db/queries/work-graph-steward");
		vi.mocked(listOrgIdsWithOpenWorkItems).mockResolvedValueOnce([
			"org-1",
			"org-2",
		]);
		vi.mocked(runWorkGraphSteward)
			.mockResolvedValueOnce({
				actions: {
					linkedDuplicateRelations: 0,
					flaggedNaming: 0,
					flaggedExpiredAttempts: 0,
				},
				report: { counts: { idleAccepted: 0, expiredAttempts: 0 } },
				errors: ["token=secret-returned"],
			} as Awaited<ReturnType<typeof runWorkGraphSteward>>)
			.mockRejectedValueOnce(new Error("token=secret-org-failure"));
		const { fetchClaudeRegistry } = await import("../rpc/routers/catalog");
		vi.mocked(fetchClaudeRegistry).mockResolvedValueOnce({
			servers: [],
			error: "token=secret-registry",
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const env = {
			DB: createD1Facade(sqlite),
			CATALOG_INTEGRITY_WORKFLOW: {
				create: vi.fn().mockResolvedValue({ id: "integrity" }),
			},
		} as unknown as CloudflareEnv;

		await runRetentionCleanupCron(
			env,
			{
				scheduledTime: Date.parse("2026-09-21T03:00:00Z"),
			} as ScheduledController,
			"retention-redaction-test",
		);

		const emitted = JSON.stringify([
			warn.mock.calls,
			error.mock.calls,
			log.mock.calls,
		]);
		expect(emitted).not.toContain("secret-");
		expect(warn).toHaveBeenCalledWith(
			"[Scheduled] Catalog base autoSync backfill failed:",
			{ type: "TypeError" },
		);
		expect(warn).toHaveBeenCalledWith(
			"[Scheduled] Work-graph steward partial errors",
			{ orgId: "org-1", count: 1 },
		);
		expect(warn).toHaveBeenCalledWith(
			"[Scheduled] Work-graph steward organization failed",
			{ orgId: "org-2", exception: { type: "Error" } },
		);
		expect(emitted).toContain("errors=2");
	} finally {
		sqlite.close();
	}
});
