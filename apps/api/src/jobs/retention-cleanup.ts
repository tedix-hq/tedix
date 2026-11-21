/// <reference path="../../worker-configuration.d.ts" />
/**
 * 3am UTC retention cleanup + catalog integrity + Claude registry sync +
 * flywheel/steward sweeps + weekly growth snapshots.
 *
 * The work is a list of named steps run one after another under one time
 * budget. On an overloaded database the whole run used to outlive the
 * scheduled invocation and was cut off before it recorded a finish (16-20
 * Nov 2026). Now:
 * - each step gets at most RETENTION_CLEANUP_STEP_CAP_MS and never more than
 *   the time left; a step that runs over is left behind and marked timed out;
 * - a step is not started when less than RETENTION_CLEANUP_MIN_STEP_MS is
 *   left; it is marked skipped;
 * - a step that throws is logged and marked failed; later steps still run;
 * - the first step that did not finish tonight runs first tomorrow (kept in
 *   platform_cron_checkpoints), so every step gets its turn;
 * - the function always returns, so the receipt always records a finish with
 *   the skipped, timed-out and failed steps in affected_row_counts.
 *
 * Each table's retention is one step. To turn a delete into a move to the
 * logs database, replace that step's `run`; the runner does not care what a
 * step does.
 */

import type { DbClient } from "@tedix/db/client";
import { safeExceptionTopology } from "../lib/safe-log-metadata";
import { withOverloadBackoff } from "../services/d1-retention-archive";

export interface WorkGraphStewardSummary {
	orgs: number;
	duplicateLinks: number;
	flags: number;
	idleAccepted: number;
	expiredAttempts: number;
	errors: number;
}

export function formatWorkGraphStewardSummary(
	summary: WorkGraphStewardSummary,
): string {
	return `[Scheduled] Work-graph steward: orgs=${summary.orgs} dupLinks=${summary.duplicateLinks} flags=${summary.flags} idleAccepted=${summary.idleAccepted} expiredAttempts=${summary.expiredAttempts} errors=${summary.errors}`;
}

/**
 * A Cloudflare scheduled invocation may run 15 minutes of wall time, and the
 * 3am trigger runs three short paths before this one. Nine minutes of steps,
 * never past 13 minutes after the scheduled time, leaves room for the
 * receipt.
 */
export const RETENTION_CLEANUP_BUDGET_MS = 9 * 60_000;
export const RETENTION_CLEANUP_LATEST_FINISH_AFTER_SCHEDULE_MS = 13 * 60_000;
export const RETENTION_CLEANUP_STEP_CAP_MS = 3 * 60_000;
export const RETENTION_CLEANUP_MIN_STEP_MS = 15_000;
/**
 * Pause between steps. Back to back, the steps refused each other and the
 * receipt write as "D1 overloaded" (21 Nov 2026: 8 of 29 steps failed in
 * 11 s and the run never recorded its finish).
 */
export const RETENTION_CLEANUP_STEP_PAUSE_MS = 1_000;
/** platform_cron_checkpoints row naming the step to start with next time. */
export const RETENTION_CLEANUP_CHECKPOINT_ID = "retention-cleanup:next-step";

const CHECKPOINT_IO_TIMEOUT_MS = 10_000;

export interface RetentionStepContext {
	/** Epoch ms after which a step that loops should stop early. */
	deadlineMs: number;
}

export interface RetentionStep {
	id: string;
	run: (
		context: RetentionStepContext,
	) => Promise<Record<string, number> | void>;
}

export interface RetentionStepRunResult {
	counts: Record<string, number>;
	/** Step to start with next time: the first one that did not finish. */
	nextStepId: string;
}

type Outcome = "completed" | "failed" | "timedOut" | "skipped";

async function withTimeout<T>(
	work: Promise<T>,
	ms: number,
): Promise<{ value: T } | "timeout"> {
	// A step left behind may still reject; that must not become unhandled.
	work.catch(() => {});
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work.then((value) => ({ value })),
			new Promise<"timeout">((resolve) => {
				timer = setTimeout(() => resolve("timeout"), Math.max(0, ms));
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Run steps in order starting at `firstStepId` (wrapping around), each
 * isolated and time-boxed. Never throws.
 */
export async function runRetentionSteps(
	steps: RetentionStep[],
	options: {
		deadlineMs: number;
		firstStepId?: string | null;
		stepCapMs?: number;
		minStepMs?: number;
		pauseMs?: number;
		now?: () => number;
	},
): Promise<RetentionStepRunResult> {
	const now = options.now ?? Date.now;
	const stepCapMs = options.stepCapMs ?? RETENTION_CLEANUP_STEP_CAP_MS;
	const minStepMs = options.minStepMs ?? RETENTION_CLEANUP_MIN_STEP_MS;
	const pauseMs = options.pauseMs ?? RETENTION_CLEANUP_STEP_PAUSE_MS;
	const start = Math.max(
		0,
		steps.findIndex((step) => step.id === options.firstStepId),
	);
	const ordered = [...steps.slice(start), ...steps.slice(0, start)];
	const outcomes: Array<[string, Outcome]> = [];
	const stepCounts: Record<string, number> = {};

	for (const [index, step] of ordered.entries()) {
		if (index > 0 && pauseMs > 0)
			await new Promise((resolve) => setTimeout(resolve, pauseMs));
		const remaining = options.deadlineMs - now();
		if (remaining < minStepMs) {
			outcomes.push([step.id, "skipped"]);
			continue;
		}
		const stepDeadline = now() + Math.min(stepCapMs, remaining);
		try {
			const result = await withTimeout(
				withOverloadBackoff(
					() => step.run({ deadlineMs: stepDeadline }),
					stepDeadline,
				),
				stepDeadline - now(),
			);
			if (result === "timeout") {
				outcomes.push([step.id, "timedOut"]);
				console.error(
					JSON.stringify({
						event: "retention_cleanup.step_timed_out",
						step: step.id,
					}),
				);
				continue;
			}
			Object.assign(stepCounts, result.value ?? {});
			outcomes.push([step.id, "completed"]);
		} catch (stepError) {
			outcomes.push([step.id, "failed"]);
			console.error(
				JSON.stringify({
					event: "retention_cleanup.step_failed",
					step: step.id,
					exception: safeExceptionTopology(stepError),
				}),
			);
		}
	}

	const tally = (outcome: Outcome) =>
		outcomes.filter(([, value]) => value === outcome).length;
	// Markers first: the receipt keeps only its first 32 keys.
	const counts: Record<string, number> = {
		stepsCompleted: tally("completed"),
		stepsFailed: tally("failed"),
		stepsTimedOut: tally("timedOut"),
		stepsSkipped: tally("skipped"),
	};
	for (const [id, outcome] of outcomes) {
		if (outcome !== "completed") counts[`${outcome}:${id}`] = 1;
	}
	Object.assign(counts, stepCounts);
	const unfinished = outcomes.find(
		([, outcome]) => outcome === "timedOut" || outcome === "skipped",
	);
	return {
		counts,
		nextStepId: unfinished?.[0] ?? steps[0]?.id ?? "",
	};
}

export async function runRetentionCleanupCron(
	env: CloudflareEnv,
	event: ScheduledController,
	runId: string,
	pauseMs = RETENTION_CLEANUP_STEP_PAUSE_MS,
): Promise<Record<string, number>> {
	const startedMs = Date.now();
	const latestFinishMs =
		event.scheduledTime + RETENTION_CLEANUP_LATEST_FINISH_AFTER_SCHEDULE_MS;
	// A scheduled time long past (a manual replay) does not shorten the run.
	const deadlineMs =
		startedMs - event.scheduledTime < 15 * 60_000
			? Math.min(startedMs + RETENTION_CLEANUP_BUDGET_MS, latestFinishMs)
			: startedMs + RETENTION_CLEANUP_BUDGET_MS;
	console.log(`[Scheduled] Running retention cleanup (${runId})`);
	const { createDbClient } = await import("@tedix/db/client");
	const db = createDbClient(env.DB);
	const scheduledDate = new Date(event.scheduledTime);
	const checkpoints =
		await import("@tedix/db/queries/platform-cron-executions");

	let firstStepId: string | null = null;
	try {
		const read = await withTimeout(
			checkpoints.getPlatformCronCheckpoint(
				db,
				RETENTION_CLEANUP_CHECKPOINT_ID,
			),
			CHECKPOINT_IO_TIMEOUT_MS,
		);
		if (read !== "timeout") firstStepId = read.value;
	} catch (checkpointReadError) {
		console.warn(
			"[Scheduled] Retention cleanup checkpoint read failed (non-fatal):",
			safeExceptionTopology(checkpointReadError),
		);
	}

	const steps = retentionCleanupSteps(env, event, runId, db, scheduledDate);
	const { counts, nextStepId } = await runRetentionSteps(steps, {
		deadlineMs,
		firstStepId,
		pauseMs,
	});

	if (nextStepId !== firstStepId) {
		try {
			await withTimeout(
				checkpoints.putPlatformCronCheckpoint(
					db,
					RETENTION_CLEANUP_CHECKPOINT_ID,
					nextStepId,
				),
				CHECKPOINT_IO_TIMEOUT_MS,
			);
		} catch (checkpointWriteError) {
			console.warn(
				"[Scheduled] Retention cleanup checkpoint write failed (non-fatal):",
				safeExceptionTopology(checkpointWriteError),
			);
		}
	}

	console.log(
		JSON.stringify({
			event: "retention_cleanup.run",
			runId,
			startedAt: firstStepId ?? steps[0]?.id,
			nextStepId,
			durationMs: Date.now() - startedMs,
			...counts,
		}),
	);
	return counts;
}

function retentionCleanupSteps(
	env: CloudflareEnv,
	event: ScheduledController,
	runId: string,
	db: DbClient,
	scheduledDate: Date,
): RetentionStep[] {
	const maintenance = () => import("@tedix/db/queries/catalog/maintenance");
	return [
		{
			id: "kernel-tool-results",
			run: async () => {
				const { cleanupKernelToolResults } =
					await import("../services/kernel-tool-result-retention");
				const cleanup = await cleanupKernelToolResults({
					db,
					bucket: env.TEDI_R2_BUCKET,
					now: scheduledDate,
					limit: 50,
				});
				return { kernelToolResultsDeleted: cleanup.deleted };
			},
		},
		{
			id: "catalog-snapshots",
			run: async () => {
				const { purgeOldCatalogSnapshots } =
					await import("../services/catalog-snapshot-retention");
				const { deleted } = await purgeOldCatalogSnapshots({
					bucket: env.R2_BUCKET,
					now: scheduledDate,
				});
				return { catalogSnapshotsDeleted: deleted };
			},
		},
		{
			id: "platform-cron-abandoned",
			run: async () => {
				const { terminalizeAbandonedPlatformCronExecutions } =
					await import("@tedix/db/queries/platform-cron-executions");
				return {
					platformCronExecutionsAbandoned:
						await terminalizeAbandonedPlatformCronExecutions(
							db,
							scheduledDate.toISOString(),
						),
				};
			},
		},
		{
			id: "catalog-autosync-backfill",
			run: async () => {
				try {
					const { backfillCatalogBaseAppAutoSync } =
						await import("@tedix/db/queries/catalog/create-base-app");
					const autoSyncBackfilled = await backfillCatalogBaseAppAutoSync(db, {
						limit: 10_000,
					});
					if (autoSyncBackfilled > 0) {
						console.log(
							`[Scheduled] Backfilled autoSync=true on ${autoSyncBackfilled} catalog base app(s)`,
						);
					}
				} catch (autoSyncBackfillError) {
					console.warn(
						`[Scheduled] Catalog base autoSync backfill failed:`,
						safeExceptionTopology(autoSyncBackfillError),
					);
				}
			},
		},
		{
			id: "health-history",
			run: async () => ({
				healthHistoryDeleted: await (
					await maintenance()
				).deleteOldHealthHistory(db, 30),
			}),
		},
		// app_catalog_changes had NO retention and grew pure-append to 115,949
		// rows of non-financial catalog-diff telemetry. 90d (matching
		// audit_events) keeps a full quarter of diff history for drift
		// investigation while capping growth; the delete is internally batched
		// so the historical backlog drains over successive nights.
		{
			id: "catalog-changes",
			run: async () => ({
				catalogChangesDeleted: await (
					await maintenance()
				).deleteOldCatalogChanges(db, 90),
			}),
		},
		{
			id: "tool-tests",
			run: async () => ({
				toolTestsDeleted: await (
					await maintenance()
				).deleteOldToolTests(db, 30),
			}),
		},
		{
			id: "jobs",
			run: async () => {
				const { cleanupOldJobs } = await import("@tedix/db/queries/jobs");
				return { jobsDeleted: await cleanupOldJobs(db, 7) };
			},
		},
		{
			id: "tedi-snapshots",
			run: async () => {
				const { cleanupOldSnapshots } = await import("@tedix/db/queries/tedis");
				return { snapshotsDeleted: await cleanupOldSnapshots(db, 7) };
			},
		},
		// Preserve all call-cost rows, including failed and unpriced usage evidence.
		// audit_events, tedi_runtime_events, kernel_runtime_events,
		// platform_cron_executions, tedi_usage_events, widget_events and
		// workflow_runs are NOT deleted here. "Keep logs": their rows leave the main database only
		// through the policy-driven engine (jobs/d1-retention.ts), which copies
		// each row to the logs database and R2 and verifies the copy before
		// removing it.
		//
		// Non-financial append-only telemetry/evidence ledgers (tedi_call_costs
		// and mcp_payment_events are deliberately EXCLUDED — financial
		// evidence). Batched; 90d for operational ledgers, 180d for evidence
		// used in longer-range before/after windows.
		{
			id: "tedi-cron-executions",
			run: async () => ({
				cronExecutionsDeleted: await (
					await maintenance()
				).deleteOldCronExecutions(db, 90),
			}),
		},
		{
			id: "skill-usage-events",
			run: async () => ({
				skillUsageDeleted: await (
					await maintenance()
				).deleteOldSkillUsageEvents(db, 90),
			}),
		},
		{
			id: "runtime-submissions",
			run: async () => ({
				runtimeSubmissionsDeleted: await (
					await maintenance()
				).deleteOldRuntimeSubmissions(db, 90),
			}),
		},
		{
			id: "learning-interaction-events",
			run: async () => ({
				learningEventsDeleted: await (
					await maintenance()
				).deleteOldLearningInteractionEvents(db, 180),
			}),
		},
		{
			id: "harness-eval-results",
			run: async () => ({
				harnessEvalResultsDeleted: await (
					await maintenance()
				).deleteOldHarnessEvalResults(db, 180),
			}),
		},
		{
			id: "harness-eval-runs",
			run: async () => ({
				harnessEvalRunsDeleted: await (
					await maintenance()
				).deleteOldHarnessEvalRuns(db, 180),
			}),
		},
		{
			id: "trace-bundles",
			run: async () => ({
				traceBundlesDeleted: await (
					await maintenance()
				).deleteOldTraceBundles(db, 180),
			}),
		},
		// The graph-projection outbox: batching lives inside the query so the
		// pass count cannot drift from the count the query verifies progress
		// against (a `RETURNING` row count reports MATCHED rows, which once hid
		// five nights of no-op deletes). 50 deletes of 250 rows: small D1
		// writes, up to 12,500 rows a night, well above the few thousand rows a
		// day the triggers append.
		{
			id: "graph-projection-outbox",
			run: async () => {
				const { pruneAcknowledgedGraphProjectionEvents } =
					await import("@tedix/db/queries/graph-projection");
				return {
					projectionEventsDeleted: await pruneAcknowledgedGraphProjectionEvents(
						db,
						{ limit: 250, maxBatches: 50 },
					),
				};
			},
		},
		{
			id: "drift-reports",
			run: async () => {
				const { deleteOldDriftReports } =
					await import("@tedix/db/queries/catalog/drift-reports");
				return { driftReportsDeleted: await deleteOldDriftReports(db, 30) };
			},
		},
		// Catalog monitoring is diagnostic; its failure must never suppress the
		// independent catalog lifecycle writes.
		{
			id: "catalog-lifecycle",
			run: async () => {
				const {
					getStaleUnhealthyAppCount,
					autoDisableDeadMcpCatalogApps,
					autoHideUnhealthyCatalogApps,
					autoDelistStaleCatalogAppsWithStats,
				} = await import("@tedix/db/queries/catalog/scheduled-maintenance");

				const staleCount = await getStaleUnhealthyAppCount(db, 14);
				if (staleCount > 0) {
					console.warn(
						`[Scheduled] WARNING: ${staleCount} apps have been unhealthy for 14+ days`,
					);
				}

				const hiddenCount = await autoHideUnhealthyCatalogApps(db, 30);
				if (hiddenCount > 0) {
					console.log(
						`[Scheduled] Auto-hidden ${hiddenCount} apps (unhealthy 30+ days)`,
					);
				}

				const disabledDeadMcp = await autoDisableDeadMcpCatalogApps(db, {
					minConsecutiveFailures: 3,
					minLastScanAgeHours: 24,
					limit: 100,
				});
				if (disabledDeadMcp.disabled > 0) {
					console.log(
						`[Scheduled] Auto-disabled ${disabledDeadMcp.disabled} dead MCP catalog apps (zero tools/resources/prompts, repeated scan failures)`,
					);
				}

				const delisted = await autoDelistStaleCatalogAppsWithStats(db, 21);
				if (delisted.delisted > 0 || delisted.skippedProtected > 0) {
					console.log(
						`[Scheduled] Auto-delisted ${delisted.delisted} apps (not seen in 21+ days; skipped ${delisted.skippedProtected} manual/auth-gated)`,
					);
				}
			},
		},
		// Safety net for the shadowed-variant flags the public catalog list
		// reads; sync, scans, merges and slug reassignment refresh them on
		// write. Placed after the lifecycle writes because visibility changes
		// move them; when a resumed run puts it first it is one day behind.
		{
			id: "catalog-shadowed-variants",
			run: async () => {
				const { refreshCatalogShadowedVariants } =
					await import("@tedix/db/queries/catalog/vendor-variants");
				const shadowed = await refreshCatalogShadowedVariants(db);
				if (shadowed.flagged > 0 || shadowed.cleared > 0) {
					console.log(
						`[Scheduled] Shadowed catalog variants: ${shadowed.flagged} flagged, ${shadowed.cleared} cleared`,
					);
				}
			},
		},
		{
			id: "catalog-integrity-workflow",
			run: async () => {
				const integrityWorkflow = await env.CATALOG_INTEGRITY_WORKFLOW.create({
					id: `catalog-integrity-${runId}`,
					params: { source: "cron", apply: true, limit: 10_000 },
				});
				console.log(
					`[Scheduled] CatalogIntegrityWorkflow started: ${integrityWorkflow.id}`,
				);
			},
		},
		// Close rationale records still pending after 48h to "partial". The
		// tedix-context plugin's auto-close only covers its in-memory state,
		// which every container reset wipes; orphaned D1 records would stay
		// pending forever and skew corpus-audit and contrastive retrieval.
		{
			id: "stale-rationale",
			run: async () => {
				const { closeStalePendingRationaleRecords } =
					await import("@tedix/db/queries/rationale-records");
				const staleRationaleCount = await closeStalePendingRationaleRecords(
					db,
					2,
				);
				if (staleRationaleCount > 0) {
					console.log(
						`[Scheduled] Stale rationale sweep: ${staleRationaleCount} records auto-closed to partial`,
					);
				}
			},
		},
		{
			id: "skill-improvement-copies",
			run: async () => {
				const { sweepAbandonedSkillImprovements } =
					await import("@tedix/db/queries/cognitive/skill-improvement-cleanup");
				const result = await sweepAbandonedSkillImprovements(db, {
					now: scheduledDate,
				});
				return { removedSkillImprovementCopies: result.removedIds.length };
			},
		},
		// Draft-TTL sweep: ordinary drafts with zero recorded usage and
		// unpromoted flow-ephemeral drafts inactive for 14 days auto-archive
		// fleet-wide. Archived, not deleted.
		{
			id: "draft-skill-ttl",
			run: async () => {
				const { sweepExpiredDraftSkills } =
					await import("@tedix/db/queries/skill-lifecycle");
				const draftSweep = await sweepExpiredDraftSkills(db, { limit: 500 });
				if (draftSweep.archived > 0) {
					const listed = draftSweep.entries
						.slice(0, 20)
						.map((entry) => entry.slug ?? entry.id)
						.join(", ");
					console.log(
						`[Scheduled] Draft-TTL sweep: archived ${draftSweep.archived} expired draft skill(s): ${listed}${draftSweep.entries.length > 20 ? "…" : ""}`,
					);
				}
			},
		},
		// Probation-TTL sweep: probation facts never retrieved within their TTL
		// auto-archive fleet-wide, in bounded batches per organization (up to
		// FACT_TTL_SWEEP_HOMEOSTAT_MAX_BATCHES_PER_ORG). Archived facts also
		// leave active semantic recall projections.
		{
			id: "probation-fact-ttl",
			run: async ({ deadlineMs }) => {
				const {
					sweepExpiredProbationFacts,
					FACT_TTL_SWEEP_HOMEOSTAT_MAX_BATCHES_PER_ORG,
				} = await import("@tedix/db/queries/fact-lifecycle");
				const probationSweep = await sweepExpiredProbationFacts(db, {
					now: scheduledDate,
					maxBatchesPerOrg: FACT_TTL_SWEEP_HOMEOSTAT_MAX_BATCHES_PER_ORG,
				});
				if (probationSweep.archivedIds.length > 0) {
					const { getFactsByIds } =
						await import("@tedix/db/queries/memory-graph/facts");
					const {
						agentMemoryProjectionProfileNames,
						deleteCanonicalMemoryProjection,
					} = await import("../integrations/cloudflare/agent-memory");
					const archivedFacts = (
						await Promise.all(
							Object.keys(probationSweep.perOrg).map((organizationId) =>
								getFactsByIds(
									db,
									{ organizationId },
									probationSweep.archivedIds,
								),
							),
						)
					).flat();
					for (const fact of archivedFacts) {
						if (Date.now() >= deadlineMs) break;
						await deleteCanonicalMemoryProjection(
							env.AGENT_MEMORY,
							agentMemoryProjectionProfileNames({
								orgId: fact.organizationId,
								tediId: fact.tediId,
								memoryScope: fact.memoryScope,
							}),
							fact.id,
						);
					}
				}
				if (probationSweep.archived > 0) {
					const perOrgSummary = Object.entries(probationSweep.perOrg)
						.map(([orgId, count]) => `${orgId}=${count}`)
						.join(", ");
					console.log(
						`[Scheduled] Probation-TTL sweep: archived ${probationSweep.archived} unretrieved probation fact(s) across ${Object.keys(probationSweep.perOrg).length} org(s): ${perOrgSummary}`,
					);
				} else {
					console.log(
						`[Scheduled] Probation-TTL sweep: no expired probation facts`,
					);
				}
			},
		},
		// Cron-darkness check: a dark consolidation tier must page, not idle.
		// Flags any expected cognitive cron overdue past 1.5x its interval and
		// mints ONE deduped system work item per dark tedi
		// (sourceIntentId=flywheel-cron-darkness:{tediId}).
		{
			id: "cron-darkness",
			run: async () => {
				const { findDarkCognitiveCrons, upsertCronDarknessWorkItems } =
					await import("@tedix/db/queries/flywheel/cron-darkness");
				const darkCrons = await findDarkCognitiveCrons(db, {
					now: event.scheduledTime,
				});
				if (darkCrons.length > 0) {
					const summary = darkCrons
						.map(
							(cron) =>
								`${cron.tediSlug ?? cron.tediId}/${cron.cronName} last=${cron.lastStartedAt ?? "never"} dark=${cron.hoursSinceLastExecution}h`,
						)
						.join("; ");
					console.error(
						`[Scheduled] DARK COGNITIVE CRONS (${darkCrons.length}): ${summary}`,
					);
					const { sourceIntentIds } = await upsertCronDarknessWorkItems(
						db,
						darkCrons,
						scheduledDate.toISOString(),
					);
					console.error(
						`[Scheduled] Cron-darkness alert work items upserted: ${sourceIntentIds.join(", ")}`,
					);
				} else {
					console.log(
						`[Scheduled] Cron-darkness check: all cognitive crons stamped within grace`,
					);
				}
			},
		},
		// Work-graph steward: daily deterministic coherence sweep per org (link
		// near-duplicate clusters, leave `steward_flag` comments on naming
		// defects or expired attempts). Never cancels a duplicate or rewrites a
		// title; those stay human calls. The org list is capped and the loop
		// stops at the step deadline.
		{
			id: "work-graph-steward",
			run: async ({ deadlineMs }) => {
				const { listOrgIdsWithOpenWorkItems, runWorkGraphSteward } =
					await import("@tedix/db/queries/work-graph-steward");
				const stewardNow = scheduledDate.toISOString();
				const orgIds = await listOrgIdsWithOpenWorkItems(db, { limit: 100 });
				let dupLinks = 0;
				let flags = 0;
				let idleAccepted = 0;
				let expiredAttempts = 0;
				let stewardErrorCount = 0;
				let visited = 0;
				for (const orgId of orgIds) {
					if (Date.now() >= deadlineMs) break;
					visited++;
					try {
						const outcome = await runWorkGraphSteward(db, {
							orgId,
							now: stewardNow,
							apply: true,
							actions: ["link_duplicates", "flag"],
						});
						dupLinks += outcome.actions.linkedDuplicateRelations;
						flags +=
							outcome.actions.flaggedNaming +
							outcome.actions.flaggedExpiredAttempts;
						idleAccepted += outcome.report.counts.idleAccepted;
						expiredAttempts += outcome.report.counts.expiredAttempts;
						if (outcome.errors.length > 0) {
							stewardErrorCount += outcome.errors.length;
							console.warn("[Scheduled] Work-graph steward partial errors", {
								orgId,
								count: outcome.errors.length,
							});
						}
					} catch (orgStewardError) {
						stewardErrorCount++;
						console.warn("[Scheduled] Work-graph steward organization failed", {
							orgId,
							exception: safeExceptionTopology(orgStewardError),
						});
					}
				}
				console.log(
					formatWorkGraphStewardSummary({
						orgs: visited,
						duplicateLinks: dupLinks,
						flags,
						idleAccepted,
						expiredAttempts,
						errors: stewardErrorCount,
					}),
				);
			},
		},
		// Weekly tedi growth snapshots (Sundays only).
		{
			id: "weekly-growth-snapshots",
			run: async ({ deadlineMs }) => {
				if (scheduledDate.getUTCDay() !== 0) return;
				console.log(
					`[Scheduled] Collecting weekly tedi growth snapshots (${runId})`,
				);
				const { collectAllTediGrowthMetrics, createGrowthSnapshot } =
					await import("@tedix/db/queries/growth-snapshots");
				const snapshotData = await collectAllTediGrowthMetrics(
					env.DB,
					scheduledDate.toISOString().slice(0, 10),
				);
				let created = 0;
				for (const data of snapshotData) {
					if (Date.now() >= deadlineMs) break;
					try {
						await createGrowthSnapshot(db, data);
						created++;
					} catch (snapErr) {
						console.warn(
							`[Scheduled] Growth snapshot failed for tedi ${data.tediId}:`,
							safeExceptionTopology(snapErr),
						);
					}
				}
				console.log(
					`[Scheduled] Growth snapshots complete: ${created}/${snapshotData.length} tedis`,
				);
			},
		},
		// Audit events stay 90 days in D1; each finished day is copied to the
		// organization's R2 storage and kept indefinitely. The
		// export takes its own budget, never past this step's deadline.
		{
			id: "audit-daily-export",
			run: async ({ deadlineMs }) => {
				const { createDbClient, configureLogStore } =
					await import("@tedix/db/client");
				const { runAuditDailyExport } =
					await import("../services/audit-daily-export");
				// Tool events live in the logs store; read both like the audit API does.
				const exportDb = createDbClient(env.DB);
				configureLogStore(exportDb, env);
				const auditExport = await runAuditDailyExport({
					db: exportDb,
					bucket: env.R2_BUCKET,
					now: scheduledDate,
					budgetMs: Math.max(
						0,
						Math.min(5 * 60_000, deadlineMs - Date.now() - 5_000),
					),
				});
				console.log(
					JSON.stringify({ event: "audit.daily_export.run", ...auditExport }),
				);
				return {
					auditExportObjectsWritten: auditExport.objectsWritten,
					auditExportObjectsDeleted: auditExport.objectsDeleted,
				};
			},
		},
	];
}
