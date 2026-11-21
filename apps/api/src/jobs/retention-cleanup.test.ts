import { DatabaseSync } from "node:sqlite";
import { tediCallCosts } from "@tedix/db/schema/tedis";
import { appCatalogHealthHistory } from "@tedix/db/schema/catalog";
import { kernelToolResults } from "@tedix/db/schema/cognitive-runtime";
import { organizations } from "@tedix/db/schema/organizations";
import { sweepAbandonedSkillImprovements } from "@tedix/db/queries/cognitive/skill-improvement-cleanup";
import { terminalizeAbandonedPlatformCronExecutions } from "@tedix/db/queries/platform-cron-executions";
import { createD1Facade } from "@tedix/db/test/d1-facade";
import { schemaDdl } from "@tedix/db/test/schema-ddl";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import {
	formatWorkGraphStewardSummary,
	runRetentionCleanupCron,
	runRetentionSteps,
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
}));
vi.mock("@tedix/db/queries/platform-cron-executions", () => ({
	terminalizeAbandonedPlatformCronExecutions: vi.fn().mockResolvedValue(2),
	getPlatformCronCheckpoint: vi.fn().mockResolvedValue(null),
	putPlatformCronCheckpoint: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@tedix/db/queries/catalog/create-base-app", () => ({
	backfillCatalogBaseAppAutoSync: vi.fn().mockResolvedValue(0),
}));
vi.mock("@tedix/db/queries/graph-projection", () => ({
	pruneAcknowledgedGraphProjectionEvents: vi.fn().mockResolvedValue(0),
}));
vi.mock("@tedix/db/queries/catalog/drift-reports", () => ({
	deleteOldDriftReports: vi.fn().mockResolvedValue(0),
}));
vi.mock("@tedix/db/queries/catalog/vendor-variants", () => ({
	refreshCatalogShadowedVariants: vi
		.fn()
		.mockResolvedValue({ flagged: 0, cleared: 0 }),
}));
vi.mock("@tedix/db/queries/catalog/scheduled-maintenance", () => ({
	getStaleUnhealthyAppCount: vi.fn().mockResolvedValue(0),
	autoDisableDeadMcpCatalogApps: vi.fn().mockResolvedValue({ disabled: 0 }),
	autoHideUnhealthyCatalogApps: vi.fn().mockResolvedValue(0),
	autoDelistStaleCatalogAppsWithStats: vi
		.fn()
		.mockResolvedValue({ delisted: 0, skippedProtected: 0 }),
}));
vi.mock("@tedix/db/queries/rationale-records", () => ({
	closeStalePendingRationaleRecords: vi.fn().mockResolvedValue(0),
}));
vi.mock("@tedix/db/queries/skill-lifecycle", () => ({
	sweepExpiredDraftSkills: vi
		.fn()
		.mockResolvedValue({ archived: 0, entries: [] }),
}));
vi.mock("@tedix/db/queries/cognitive/skill-improvement-cleanup", () => ({
	sweepAbandonedSkillImprovements: vi
		.fn()
		.mockResolvedValue({ removedIds: ["old-copy"] }),
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
afterEach(() => vi.restoreAllMocks());

const emptyBucket = () => ({
	list: vi.fn().mockResolvedValue({ objects: [], truncated: false }),
	delete: vi.fn(),
});

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
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			const env = {
				DB: createD1Facade(sqlite),
				R2_BUCKET: emptyBucket(),
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
				0,
			);
			expect(
				sqlite
					.prepare("SELECT id FROM app_catalog_health_history ORDER BY id")
					.all(),
			).toEqual([{ id: "recent" }]);
			expect(result.healthHistoryDeleted).toBe(1);
			expect(result.removedSkillImprovementCopies).toBe(1);
			expect(sweepAbandonedSkillImprovements).toHaveBeenCalledWith(
				expect.anything(),
				{
					now: new Date("2026-09-21T03:00:00Z"),
				},
			);
			expect(result.platformCronExecutionsAbandoned).toBe(2);
			expect(terminalizeAbandonedPlatformCronExecutions).toHaveBeenCalledWith(
				expect.anything(),
				"2026-09-21T03:00:00.000Z",
			);
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
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		const env = {
			DB: createD1Facade(sqlite),
			R2_BUCKET: emptyBucket(),
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
			0,
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

describe("retention step runner", () => {
	it("finishes on a hung step, records what did not run and resumes there next time", async () => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		let clock = 0;
		const ran: string[] = [];
		const step = (
			id: string,
			run: () => Promise<Record<string, number> | void>,
		) => ({
			id,
			run: async () => {
				ran.push(id);
				return run();
			},
		});
		const steps = [
			step("a", async () => ({ aDeleted: 1 })),
			step("hangs", () => new Promise(() => {})),
			step("throws", async () => {
				throw new Error("boom");
			}),
			step("slow", async () => {
				clock += 100;
			}),
			step("never", async () => ({ neverDeleted: 1 })),
		];

		const first = await runRetentionSteps(steps, {
			deadlineMs: 100,
			stepCapMs: 5,
			minStepMs: 10,
			pauseMs: 0,
			now: () => clock,
		});

		expect(ran).toEqual(["a", "hangs", "throws", "slow"]);
		expect(first.counts).toMatchObject({
			stepsCompleted: 2,
			stepsFailed: 1,
			stepsTimedOut: 1,
			stepsSkipped: 1,
			"timedOut:hangs": 1,
			"failed:throws": 1,
			"skipped:never": 1,
			aDeleted: 1,
		});
		expect(first.nextStepId).toBe("hangs");

		ran.length = 0;
		clock = 0;
		const second = await runRetentionSteps(steps.slice(2), {
			deadlineMs: 1_000,
			firstStepId: "never",
			stepCapMs: 5,
			minStepMs: 10,
			pauseMs: 0,
			now: () => clock,
		});
		expect(ran).toEqual(["never", "throws", "slow"]);
		expect(second.nextStepId).toBe("throws");
	});
});
