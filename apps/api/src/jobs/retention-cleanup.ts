/// <reference path="../../worker-configuration.d.ts" />
/**
 * 3am UTC retention cleanup + catalog integrity + Claude registry sync +
 * flywheel/steward sweeps + weekly growth snapshots. Independent maintenance
 * domains fail softly so one stale diagnostic cannot suppress later work.
 */

import { safeExceptionTopology } from "../lib/safe-log-metadata";

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

export async function runRetentionCleanupCron(
	env: CloudflareEnv,
	event: ScheduledController,
	runId: string,
): Promise<Record<string, number>> {
	console.log(`[Scheduled] Running retention cleanup (${runId})`);
	const { createDbClient } = await import("@tedix/db/client");
	const {
		deleteOldHealthHistory,
		deleteOldCatalogChanges,
		deleteOldToolTests,
		deleteOldAuditEvents,
		deleteOldTediRuntimeEvents,
		deleteOldKernelRuntimeEvents,
		deleteOldCronExecutions,
		deleteOldSkillUsageEvents,
		deleteOldRuntimeSubmissions,
		deleteOldLearningInteractionEvents,
		deleteOldHarnessEvalResults,
		deleteOldHarnessEvalRuns,
		deleteOldTraceBundles,
	} = await import("@tedix/db/queries/catalog/maintenance");
	const { cleanupOldJobs } = await import("@tedix/db/queries/jobs");
	const { cleanupOldSnapshots, cleanupOldUsageEvents } =
		await import("@tedix/db/queries/tedis");
	const db = createDbClient(env.DB);
	let deletedKernelToolResults = 0;
	try {
		const { cleanupKernelToolResults } =
			await import("../services/kernel-tool-result-retention");
		const cleanup = await cleanupKernelToolResults({
			db,
			bucket: env.TEDI_R2_BUCKET,
			now: new Date(event.scheduledTime),
			limit: 50,
		});
		deletedKernelToolResults = cleanup.deleted;
	} catch (toolResultCleanupError) {
		console.warn(
			"[Scheduled] Kernel tool-result cleanup failed (non-fatal):",
			safeExceptionTopology(toolResultCleanupError),
		);
	}
	let deletedPlatformCronExecutions = 0;
	try {
		const {
			PLATFORM_CRON_RECEIPT_RETENTION_DAYS,
			prunePlatformCronExecutions,
		} = await import("@tedix/db/queries/platform-cron-executions");
		const cutoff = new Date(
			event.scheduledTime - PLATFORM_CRON_RECEIPT_RETENTION_DAYS * 86_400_000,
		)
			.toISOString()
			.replace("T", " ")
			.slice(0, 19);
		deletedPlatformCronExecutions = await prunePlatformCronExecutions(
			db,
			cutoff,
		);
	} catch (platformCronRetentionError) {
		console.error(
			"[Scheduled] Platform-cron receipt retention failed (non-fatal):",
			safeExceptionTopology(platformCronRetentionError),
		);
	}

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

	const { deleteOldWidgetEvents } = await import("@tedix/db/queries/analytics");

	const deletedHealth = await deleteOldHealthHistory(db, 30);
	// app_catalog_changes had NO retention and grew pure-append to 115,949 rows
	// of non-financial catalog-diff telemetry. 90d (matching audit_events) keeps a
	// full quarter of diff history for drift investigation while capping growth;
	// the delete is internally batched so the historical backlog drains over
	// successive nights instead of one oversized D1 transaction.
	const deletedCatalogChanges = await deleteOldCatalogChanges(db, 90);
	const deletedTests = await deleteOldToolTests(db, 30);
	const deletedAudit = await deleteOldAuditEvents(db, 90);
	const deletedJobs = await cleanupOldJobs(db, 7);
	const deletedSnapshots = await cleanupOldSnapshots(db, 7);
	const deletedUsageEvents = await cleanupOldUsageEvents(db, 30);
	// Preserve all call-cost rows, including failed and unpriced usage evidence.
	const deletedWidgetEvents = await deleteOldWidgetEvents(db, 30);
	const { deleteOldWorkflowRunRecords } =
		await import("@tedix/db/queries/workflow-runs");
	const deletedWorkflowRuns = await deleteOldWorkflowRunRecords(db, 90);

	// Runtime-event ledgers (tedi_runtime_events / kernel_runtime_events)
	// had NO retention and are the platform's highest-write tables (the
	// documented D1-overload hotspot). Prune in bounded batches, 90d window
	// (matches audit). Isolated in its own try/catch so a D1 hiccup on these
	// hot tables never aborts the rest of the retention cron or marks the
	// scheduled event failed (fail-soft).
	let deletedTediEvents = 0;
	let deletedKernelEvents = 0;
	try {
		deletedTediEvents = await deleteOldTediRuntimeEvents(db, 90);
		deletedKernelEvents = await deleteOldKernelRuntimeEvents(db, 90);
	} catch (runtimeRetentionError) {
		console.warn(
			`[Scheduled] Runtime-event retention failed (non-fatal):`,
			safeExceptionTopology(runtimeRetentionError),
		);
	}

	// Non-financial append-only telemetry/evidence ledgers (tedi_call_costs
	// and mcp_payment_events are deliberately EXCLUDED — financial evidence).
	// Batched, isolated in its own try/catch so a D1 hiccup on any one table
	// never aborts the rest of the retention cron. 90d for operational
	// ledgers; 180d for evidence used in longer-range before/after windows.
	let deletedCronExecutions = 0;
	let deletedSkillUsage = 0;
	let deletedRuntimeSubmissions = 0;
	let deletedLearningEvents = 0;
	let deletedHarnessEvalResults = 0;
	let deletedHarnessEvalRuns = 0;
	let deletedTraceBundles = 0;
	try {
		deletedCronExecutions = await deleteOldCronExecutions(db, 90);
		deletedSkillUsage = await deleteOldSkillUsageEvents(db, 90);
		deletedRuntimeSubmissions = await deleteOldRuntimeSubmissions(db, 90);
		deletedLearningEvents = await deleteOldLearningInteractionEvents(db, 180);
		deletedHarnessEvalResults = await deleteOldHarnessEvalResults(db, 180);
		deletedHarnessEvalRuns = await deleteOldHarnessEvalRuns(db, 180);
		deletedTraceBundles = await deleteOldTraceBundles(db, 180);
	} catch (ledgerRetentionError) {
		console.warn(
			`[Scheduled] Ledger retention failed (non-fatal):`,
			safeExceptionTopology(ledgerRetentionError),
		);
	}

	// The graph-projection outbox had a retention function since it was
	// written and NO caller, so it grew append-only: 190,640 rows at the
	// time of wiring, every one of them acknowledged and past the 7-day
	// diagnostic window. Batching lives inside the query (like the other
	// bounded prunes) so the pass count cannot drift from the count the
	// query verifies progress against: this loop used to trust a
	// `RETURNING` row count, which reports MATCHED rows, so it reported
	// 10 x 5,000 deletions per night for five nights against a table from
	// which nothing was ever deleted. Own try/catch, like the ledgers
	// above, so a D1 hiccup cannot fail the retention run -- but at
	// `console.error`, because a prune that cannot delete is a defect, not
	// a hiccup, and the previous `console.warn` is what let it hide.
	let prunedProjectionEvents = 0;
	try {
		const { pruneAcknowledgedGraphProjectionEvents } =
			await import("@tedix/db/queries/graph-projection");
		prunedProjectionEvents = await pruneAcknowledgedGraphProjectionEvents(db, {
			limit: 5_000,
			maxBatches: 10,
		});
	} catch (projectionRetentionError) {
		console.error(
			`[Scheduled] Graph-projection outbox retention failed (non-fatal):`,
			safeExceptionTopology(projectionRetentionError),
		);
	}

	// Clean up old resolved drift reports (30 days)
	const { deleteOldDriftReports } =
		await import("@tedix/db/queries/catalog/drift-reports");
	const deletedDriftReports = await deleteOldDriftReports(db, 30);

	console.log(
		`[Scheduled] Retention cleanup complete: health=${deletedHealth}, catalogChanges=${deletedCatalogChanges}, tests=${deletedTests}, audit=${deletedAudit}, jobs=${deletedJobs}, snapshots=${deletedSnapshots}, usageEvents=${deletedUsageEvents}, widgetEvents=${deletedWidgetEvents}, driftReports=${deletedDriftReports}, workflowRuns=${deletedWorkflowRuns}, tediEvents=${deletedTediEvents}, kernelEvents=${deletedKernelEvents}, cronExecutions=${deletedCronExecutions}, platformCronExecutions=${deletedPlatformCronExecutions}, skillUsage=${deletedSkillUsage}, runtimeSubmissions=${deletedRuntimeSubmissions}, learningEvents=${deletedLearningEvents}, harnessEvalResults=${deletedHarnessEvalResults}, harnessEvalRuns=${deletedHarnessEvalRuns}, traceBundles=${deletedTraceBundles}, projectionOutbox=${prunedProjectionEvents}`,
	);

	// Catalog monitoring is diagnostic. It must never suppress the independent
	// catalog lifecycle writes or the rationale/TTL/steward work below.
	try {
		const {
			getStaleUnhealthyAppCount,
			autoDisableDeadMcpCatalogApps,
			autoHideUnhealthyCatalogApps,
			autoDelistStaleCatalogApps,
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

		const delistedCount = await autoDelistStaleCatalogApps(db, 21);
		if (delistedCount > 0) {
			console.log(
				`[Scheduled] Auto-delisted ${delistedCount} apps (not seen in 21+ days)`,
			);
		}
	} catch (catalogLifecycleError) {
		console.warn(
			"[Scheduled] Catalog lifecycle maintenance failed (non-fatal):",
			safeExceptionTopology(catalogLifecycleError),
		);
	}

	try {
		const integrityWorkflow = await env.CATALOG_INTEGRITY_WORKFLOW.create({
			id: `catalog-integrity-${runId}`,
			params: {
				source: "cron",
				apply: true,
				limit: 10_000,
			},
		});
		console.log(
			`[Scheduled] CatalogIntegrityWorkflow started: ${integrityWorkflow.id}`,
		);
	} catch (catalogIntegrityError) {
		console.warn(
			"[Scheduled] CatalogIntegrityWorkflow queueing failed (non-fatal):",
			safeExceptionTopology(catalogIntegrityError),
		);
	}

	// Stale rationale sweep — close any rationale records still pending
	// after 48h to "partial". The tedix-context plugin's auto-close only
	// runs on records in its local in-memory state, which gets wiped
	// every container reset; D1 records orphaned by reset stay pending
	// forever, polluting corpus-audit and skewing the contrastive
	// retrieval distribution.
	const { closeStalePendingRationaleRecords } =
		await import("@tedix/db/queries/rationale-records");
	const staleRationaleCount = await closeStalePendingRationaleRecords(db, 2);
	if (staleRationaleCount > 0) {
		console.log(
			`[Scheduled] Stale rationale sweep: ${staleRationaleCount} records auto-closed to partial`,
		);
	}

	// Draft-TTL sweep — execute-to-promote lifecycle:
	// Ordinary drafts with zero recorded usage and unpromoted flow-ephemeral
	// drafts inactive for 14 days auto-archive fleet-wide. Archived, not deleted.
	try {
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
	} catch (draftSweepError) {
		console.warn(
			`[Scheduled] Draft-TTL sweep failed (non-fatal):`,
			safeExceptionTopology(draftSweepError),
		);
	}

	// Probation-TTL sweep: probation facts never retrieved
	// (access_count = 0) within their TTL auto-archive, fleet-wide.
	// Default 14 days; unlinked afterTurn facts carry a shorter TTL in
	// metadata.brainAdmission.ttlDays. Batched ≤200/org/day inside the
	// sweep to stay under D1 limits. Archived facts must also leave
	// active semantic recall projections (brain.md cleanup rule).
	try {
		const {
			sweepExpiredProbationFacts,
			FACT_TTL_SWEEP_HOMEOSTAT_MAX_BATCHES_PER_ORG,
		} = await import("@tedix/db/queries/fact-lifecycle");
		// Guarantee the disposal plane a protected drain budget (up to
		// 2,000/org/cycle in bounded batches) so the sweep converges the
		// probation backlog instead of being
		// crowded out by the fast admission loop. The kernel/scheduled
		// governance owns the budget; the memory plane does the mechanical
		// drain (no LLM). See decisions/agentic-kernel-architecture.md.
		const probationSweep = await sweepExpiredProbationFacts(db, {
			now: new Date(event.scheduledTime),
			maxBatchesPerOrg: FACT_TTL_SWEEP_HOMEOSTAT_MAX_BATCHES_PER_ORG,
		});
		if (probationSweep.archivedIds.length > 0) {
			const { getFactsByIds } =
				await import("@tedix/db/queries/memory-graph/facts");
			const {
				agentMemoryProjectionProfileNames,
				deleteCanonicalMemoryProjection,
			} = await import("../integrations/cloudflare/agent-memory");
			const archivedFacts = await getFactsByIds(db, probationSweep.archivedIds);
			for (const fact of archivedFacts) {
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
	} catch (probationSweepError) {
		console.warn(
			`[Scheduled] Probation-TTL sweep failed (non-fatal):`,
			safeExceptionTopology(probationSweepError),
		);
	}

	// Cron-darkness check: a dark consolidation tier must page, not idle
	// (cognitive crons can be silently unscheduled). Reads tedi_cron_executions
	// fleet-wide, flags any expected cognitive cron overdue past 1.5× its
	// interval, logs loudly, and mints ONE deduped system work item per
	// dark tedi (sourceIntentId=flywheel-cron-darkness:{tediId} — repeated
	// dark days refresh the same item instead of duplicating).
	try {
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
				new Date(event.scheduledTime).toISOString(),
			);
			console.error(
				`[Scheduled] Cron-darkness alert work items upserted: ${sourceIntentIds.join(", ")}`,
			);
		} else {
			console.log(
				`[Scheduled] Cron-darkness check: all cognitive crons stamped within grace`,
			);
		}
	} catch (cronDarknessError) {
		console.error(
			`[Scheduled] Cron-darkness check failed (non-fatal):`,
			safeExceptionTopology(cronDarknessError),
		);
	}

	// Work-graph steward — daily coherence sweep that keeps each org's
	// WorkSpec/projects graph coherent: link near-duplicate clusters and leave
	// `steward_flag` comments on naming defects or expired attempts. It observes
	// idle accepted specs but never mutates their disposition. Deterministic (no
	// LLM). Per-org because duplicate
	// clustering is org-scoped; the org list is capped so one dark org can't
	// unbound the handler, and each per-org run is windowed/capped and fully
	// idempotent. Never cancels a duplicate or rewrites a title — those stay
	// human calls. Own try/catch so a failure never blocks the rest of the
	// daily maintenance block.
	try {
		const { listOrgIdsWithOpenWorkItems, runWorkGraphSteward } =
			await import("@tedix/db/queries/work-graph-steward");
		const stewardNow = new Date(event.scheduledTime).toISOString();
		const orgIds = await listOrgIdsWithOpenWorkItems(db, { limit: 100 });
		let dupLinks = 0;
		let flags = 0;
		let idleAccepted = 0;
		let expiredAttempts = 0;
		let stewardErrorCount = 0;
		for (const orgId of orgIds) {
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
				orgs: orgIds.length,
				duplicateLinks: dupLinks,
				flags,
				idleAccepted,
				expiredAttempts,
				errors: stewardErrorCount,
			}),
		);
	} catch (stewardError) {
		console.warn(
			`[Scheduled] Work-graph steward failed (non-fatal):`,
			safeExceptionTopology(stewardError),
		);
	}

	const dayOfWeek = new Date(event.scheduledTime).getUTCDay(); // 0 = Sunday
	if (dayOfWeek === 0) {
		// Weekly tedi growth snapshots — collect cognitive metrics for all active tedis
		try {
			console.log(
				`[Scheduled] Collecting weekly tedi growth snapshots (${runId})`,
			);
			const { collectAllTediGrowthMetrics, createGrowthSnapshot } =
				await import("@tedix/db/queries/growth-snapshots");
			const { createDbClient } = await import("@tedix/db/client");
			const snapshotDb = createDbClient(env.DB);
			const snapshotDate = new Date(event.scheduledTime)
				.toISOString()
				.slice(0, 10);

			const snapshotData = await collectAllTediGrowthMetrics(
				env.DB,
				snapshotDate,
			);
			let created = 0;
			for (const data of snapshotData) {
				try {
					await createGrowthSnapshot(snapshotDb, data);
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
		} catch (growthError) {
			// Best-effort: don't fail retention cron if growth snapshots fail
			console.warn(
				`[Scheduled] Growth snapshot collection failed:`,
				safeExceptionTopology(growthError),
			);
		}
	}
	return {
		healthHistoryDeleted: deletedHealth,
		catalogChangesDeleted: deletedCatalogChanges,
		toolTestsDeleted: deletedTests,
		auditEventsDeleted: deletedAudit,
		jobsDeleted: deletedJobs,
		snapshotsDeleted: deletedSnapshots,
		usageEventsDeleted: deletedUsageEvents,
		widgetEventsDeleted: deletedWidgetEvents,
		workflowRunsDeleted: deletedWorkflowRuns,
		tediEventsDeleted: deletedTediEvents,
		kernelEventsDeleted: deletedKernelEvents,
		cronExecutionsDeleted: deletedCronExecutions,
		platformCronExecutionsDeleted: deletedPlatformCronExecutions,
		skillUsageDeleted: deletedSkillUsage,
		runtimeSubmissionsDeleted: deletedRuntimeSubmissions,
		learningEventsDeleted: deletedLearningEvents,
		projectionEventsDeleted: prunedProjectionEvents,
		kernelToolResultsDeleted: deletedKernelToolResults,
	};
}
