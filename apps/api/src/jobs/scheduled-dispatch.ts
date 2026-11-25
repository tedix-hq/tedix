import { fleetAuthorityIsEnabled } from "../lib/fleet-authority";
import {
	safeErrorClassification,
	safeExceptionTopology,
} from "../lib/safe-log-metadata";
import type { PlatformCronId } from "./platform-cron-catalog";
import { MAINTENANCE_TRIGGER, maintenanceIsDue } from "./staggered-maintenance";

async function trackPlatformCronPath(
	env: CloudflareEnv,
	event: ScheduledController,
	scheduleId: PlatformCronId,
	run: () => Promise<Record<string, number> | void>,
): Promise<void> {
	const { runPlatformCronPath } = await import("./platform-cron-receipts");
	try {
		await runPlatformCronPath(env, event, scheduleId, run);
	} catch (error) {
		// A multiplexed Cron Trigger must keep later maintenance paths alive. The
		// path receipt is the failure/retry signal; replaying the whole trigger
		// would duplicate unrelated side effects that already succeeded.
		console.error(
			JSON.stringify({
				event: "platform.cron.path_failed",
				scheduleId,
				exception: safeExceptionTopology(error),
				...safeErrorClassification(error),
			}),
		);
	}
}

/**
 * Scheduled event handler for cron-triggered workflows.
 *
 * The existing two-minute installation and quarter-hour billing ticks retain
 * their cadence. Daily, hourly and D1 retention jobs use the odd-minute trigger
 * and distinct slots in staggered-maintenance.ts. Legacy top-of-hour triggers
 * are harmless during provider rollout: no maintenance branch handles them.
 *
 * Private tenant skills own supplier feeds; the Claude registry is a supplemental
 * official source.
 *
 * This module stays a thin dispatcher with only the fleet-authority seam as a
 * static import: every fleet-commercial schedule is gated behind
 * `fleetEnabled &&` BEFORE its job module is imported, which is what
 * scheduled-dispatch.test.ts proves against the authority classification.
 */
const dispatchScheduled = async (
	event: ScheduledController,
	env: CloudflareEnv,
	ctx: ExecutionContext,
) => {
	const backgroundPaths: Promise<void>[] = [];
	const hour = new Date(event.scheduledTime).getUTCHours();
	const minute = new Date(event.scheduledTime).getUTCMinutes();
	const cron = event.cron;
	const runId = `cron-${event.scheduledTime}`;
	const fleetEnabled = fleetAuthorityIsEnabled(env);

	console.log(
		`[Scheduled] Cron triggered: cron=${cron}, hour=${hour} UTC, scheduledTime=${new Date(event.scheduledTime).toISOString()}`,
	);

	// Thin dispatcher: each scheduled domain lives in a jobs/<domain>.ts module.
	// Job modules stay behind `await import()`
	// so they never join the first-request eval floor.
	try {
		if (cron === "*/2 * * * *") {
			await trackPlatformCronPath(
				env,
				event,
				"agent-session-event-drain",
				async () => {
					const { dispatchPendingAgentSessionEvents } =
						await import("./agent-session-event-drain");
					return dispatchPendingAgentSessionEvents(env);
				},
			);
		}
		if (maintenanceIsDue("decision-outcome-labeller", event)) {
			const { runDecisionOutcomeLabeller } =
				await import("./decision-outcome-labeller");
			await trackPlatformCronPath(env, event, "decision-outcome-labeller", () =>
				runDecisionOutcomeLabeller(env, event.scheduledTime),
			);
		}
		// Each card can require several governed model calls.
		if (maintenanceIsDue("card-summary-backfill", event)) {
			const { runCardSummaryBackfill } =
				await import("./decision-outcome-labeller");
			await trackPlatformCronPath(env, event, "card-summary-backfill", () =>
				runCardSummaryBackfill(env, event.scheduledTime),
			);
		}

		if (cron === "*/2 * * * *") {
			await trackPlatformCronPath(
				env,
				event,
				"provider-event-maintenance",
				async () => {
					const { maintainProviderEvents } = await import("./provider-events");
					return maintainProviderEvents(env);
				},
			);
		}

		if (cron === "*/2 * * * *") {
			const {
				dispatchGraphProjectionDrains,
				dispatchDueSkillSchedulesTick,
				dispatchDueAppTriggersTick,
			} = await import("./platform-tick");
			await trackPlatformCronPath(env, event, "graph-projection-drain", () =>
				dispatchGraphProjectionDrains(env, event),
			);
			await trackPlatformCronPath(env, event, "skill-schedule-dispatch", () =>
				dispatchDueSkillSchedulesTick(env, event),
			);
			await trackPlatformCronPath(env, event, "app-trigger-dispatch", () =>
				dispatchDueAppTriggersTick(env, event),
			);
		}

		if (cron === "*/2 * * * *" && env.TEDI_SERVICE) {
			const { runAlwaysOnKeepalive } = await import("./platform-tick");
			await trackPlatformCronPath(env, event, "always-on-keepalive", () =>
				runAlwaysOnKeepalive(env, ctx),
			);
		}

		if (cron === "*/2 * * * *") {
			const { dispatchWorkDue } = await import("./work-due");
			await trackPlatformCronPath(env, event, "work-due", () =>
				dispatchWorkDue(env, event.scheduledTime, (kind, run) =>
					trackPlatformCronPath(env, event, kind, run),
				),
			);
		}

		if (cron === "*/2 * * * *") {
			await trackPlatformCronPath(env, event, "work-maintenance", async () => {
				const { runWorkMaintenanceTick } =
					await import("./work-attempt-lease-sweeper");
				return runWorkMaintenanceTick(env, event.scheduledTime);
			});
			await trackPlatformCronPath(env, event, "owner-tool-queue", async () => {
				const { createContext } = await import("../rpc/context");
				const { runQueuedOwnerToolApprovals } =
					await import("../rpc/routers/kernel/owner-tool-approval-settlement");
				return {
					retried: await runQueuedOwnerToolApprovals(
						createContext(
							new Request("https://api.internal/approval-queue"),
							env,
						),
					),
				};
			});
			await trackPlatformCronPath(
				env,
				event,
				"orphan-workflow-cleanup",
				async () => {
					const { createDbClient } = await import("@tedix/db/client");
					const { cleanupOrphanWorkflows } =
						await import("./orphan-workflow-cleanup");
					return cleanupOrphanWorkflows(createDbClient(env.DB), env);
				},
			);
			// Remote follow-through keeps its own receipts: a wedged tedi or
			// Durable Object must fail these paths, not the pure-D1 lease reaper.
			const { reconcileDueKernelRequests } =
				await import("./kernel-request-reconcile");
			await trackPlatformCronPath(env, event, "kernel-request-reconcile", () =>
				reconcileDueKernelRequests(env, event.scheduledTime),
			);
		}

		if (cron === "*/2 * * * *") {
			// No AI: raises one attention item per organization while Work waits and
			// neither an Attempt admission nor a request-tracker action is recent.
			const { runDispatcherHealthAlarm } =
				await import("./dispatcher-health-alarm");
			await trackPlatformCronPath(env, event, "dispatcher-health-alarm", () =>
				runDispatcherHealthAlarm(env, event.scheduledTime),
			);
		}

		if (cron === "*/2 * * * *" && env.TEDI_SERVICE) {
			// Each tick reads one bounded slice; the checkpoint carries unfinished
			// scope counts to later ticks instead of draining the whole inventory.
			if (minute % 6 < 2) {
				const { createDbClient } = await import("@tedix/db/client");
				const { dispatchStallRecovery } = await import("./stall-recovery");
				// Recovery has its own receipt and lifetime; it must not hold replay or later paths.
				const recovery = trackPlatformCronPath(
					env,
					event,
					"stall-recovery",
					async () => ({
						resumeRequested: await dispatchStallRecovery(
							createDbClient(env.DB),
							env,
							event.scheduledTime,
						),
					}),
				);
				backgroundPaths.push(recovery);
				ctx.waitUntil(recovery);
			}
			if (minute % 10 < 2) {
				// Accepted non-coding Work with no executor goes to its steward tedi.
				const { dispatchWorkRouting } = await import("./work-routing");
				await trackPlatformCronPath(env, event, "work-routing", () =>
					dispatchWorkRouting(env, event.scheduledTime),
				);
			}
			const { dispatchCommitmentWakes } = await import("./commitment-wakes");
			await trackPlatformCronPath(env, event, "commitment-wakes", () =>
				dispatchCommitmentWakes(env, event.scheduledTime),
			);
			await trackPlatformCronPath(
				env,
				event,
				"repository-observer",
				async () => {
					const { maintainRepositoryObservers } =
						await import("./repository-observer");
					return maintainRepositoryObservers(env);
				},
			);
		}

		if (cron === "*/15 * * * *" && env.TEDI_SERVICE) {
			const { maintainSupport } = await import("./support-maintenance");
			await trackPlatformCronPath(env, event, "support-maintenance", () =>
				maintainSupport(env),
			);
		}

		if (
			cron === "*/2 * * * *" &&
			minute % 10 < 2 &&
			(env.TEDI_SERVICE || fleetEnabled)
		) {
			const { dispatchTediMemoryReflection } =
				await import("./tedi-memory-reflection");
			await trackPlatformCronPath(env, event, "tedi-memory-reflection", () =>
				dispatchTediMemoryReflection(env, event.scheduledTime, runId),
			);
		}

		if (cron === "*/2 * * * *" && env.MCP_SERVICE) {
			const { runMcpEventWebhookDelivery } =
				await import("./mcp-event-webhooks");
			await trackPlatformCronPath(
				env,
				event,
				"mcp-event-webhook-delivery",
				() => runMcpEventWebhookDelivery(env),
			);
		}

		// Thins editor auto-save revisions out of file history. An operator
		// arms it; unarmed it costs one bucket read and no D1.
		if (cron === "*/2 * * * *") {
			try {
				const { createDbQueryClient } = await import("@tedix/db/query-client");
				const { runOutputRevisionThinningTick } =
					await import("../services/os-output-revision-thinning");
				const result = await runOutputRevisionThinningTick({
					db: createDbQueryClient(env.DB),
					runtime: (
						env as unknown as {
							WORKSPACE_RUNTIME?: Parameters<
								typeof runOutputRevisionThinningTick
							>[0]["runtime"];
						}
					).WORKSPACE_RUNTIME,
					bucket: env.R2_BUCKET,
					now: new Date(event.scheduledTime),
				});
				if (result.status !== "off" && result.status !== "waiting")
					console.log(
						JSON.stringify({
							event: "os.output_revision_thinning.tick",
							...result,
						}),
					);
			} catch (error) {
				console.error(
					JSON.stringify({
						event: "os.output_revision_thinning.failed",
						exception: safeExceptionTopology(error),
						...safeErrorClassification(error),
					}),
				);
			}
		}

		// Deck sweep: every 15 minutes on the installation tick (not fleet-commercial).
		if (cron === "*/2 * * * *" && minute % 15 < 2) {
			const { sweepDeckPipeline } = await import("./deck-pipeline-sweep");
			await trackPlatformCronPath(env, event, "deck-pipeline-sweep", () =>
				sweepDeckPipeline(env, event.scheduledTime),
			);
		}

		if (fleetEnabled && cron === "*/15 * * * *" && env.TEDI_SERVICE) {
			const { sweepAgentReviewTriage } = await import("./agent-review-triage");
			await trackPlatformCronPath(env, event, "agent-review-triage", () =>
				sweepAgentReviewTriage(env, event.scheduledTime),
			);
		}

		if (fleetEnabled && cron === "*/15 * * * *") {
			const { runBillingAndGatewayCostTick } = await import("./billing-cron");
			await trackPlatformCronPath(env, event, "billing-and-gateway-cost", () =>
				runBillingAndGatewayCostTick(env),
			);
			// Reap BEFORE metering, so a lease expired on this tick is billed on
			// the same pass instead of waiting for the next one.
			const { runWorkstationLeaseReaperTick } =
				await import("./workstation-lease-reaper");
			await trackPlatformCronPath(env, event, "workstation-lease-reaper", () =>
				runWorkstationLeaseReaperTick(env),
			);
			// Rides the billing tick: container time is provider-cost evidence in
			// the same ledger, and a finished lease should not wait a day to be
			// attributable when a runaway workstation is what we want to catch.
			const { runWorkstationComputeMeteringTick } =
				await import("./workstation-compute-metering");
			await trackPlatformCronPath(
				env,
				event,
				"workstation-compute-metering",
				() => runWorkstationComputeMeteringTick(env),
			);
		}

		// Bounded log moves run between the quarter-hour billing ticks.
		if (fleetEnabled && maintenanceIsDue("d1-retention", event)) {
			const { runD1RetentionTick } = await import("./d1-retention");
			await trackPlatformCronPath(env, event, "d1-retention", () =>
				runD1RetentionTick(env, event),
			);
		}

		if (
			fleetEnabled &&
			maintenanceIsDue("tedi-mcp-access-health", event) &&
			env.TEDI_MCP_ACCESS_HEALTH_WORKFLOW
		) {
			const { queueTediMcpAccessHealthWorkflow } =
				await import("./tedi-mcp-access-health");
			await trackPlatformCronPath(
				env,
				event,
				"tedi-mcp-access-health",
				async () => {
					queueTediMcpAccessHealthWorkflow(env, ctx);
				},
			);
		}

		if (fleetEnabled && maintenanceIsDue("site-versions", event)) {
			const { runSiteVersionCheckTick } = await import("./site-versions");
			await trackPlatformCronPath(env, event, "site-versions", () =>
				runSiteVersionCheckTick(env),
			);
		}

		if (
			fleetEnabled &&
			maintenanceIsDue("daily-billing-and-catalog-maintenance", event)
		) {
			const { runDailyBillingAndCatalogMaintenance } =
				await import("./daily-billing-and-catalog-maintenance");
			await trackPlatformCronPath(
				env,
				event,
				"daily-billing-and-catalog-maintenance",
				() => runDailyBillingAndCatalogMaintenance(env, runId),
			);
		}

		if (fleetEnabled && maintenanceIsDue("cloudflare-billable-usage", event)) {
			const { runCloudflareBillableUsageTick } =
				await import("./cloudflare-billable-usage");
			await trackPlatformCronPath(env, event, "cloudflare-billable-usage", () =>
				runCloudflareBillableUsageTick(env),
			);
		}

		if (
			fleetEnabled &&
			maintenanceIsDue("gateway-cost-reconciliation", event)
		) {
			const { runGatewayCostReconciliationTick } =
				await import("./gateway-cost-reconciliation");
			await trackPlatformCronPath(
				env,
				event,
				"gateway-cost-reconciliation",
				() => runGatewayCostReconciliationTick(env, event.scheduledTime),
			);
		}

		if (fleetEnabled && maintenanceIsDue("output-asset-gc", event)) {
			await trackPlatformCronPath(env, event, "output-asset-gc", async () => {
				const { createDbClient } = await import("@tedix/db/client");
				const { sweepDeletedOrganizationOutputAssets } =
					await import("../services/os-output-asset-gc");
				return {
					assetsRemoved: await sweepDeletedOrganizationOutputAssets({
						db: createDbClient(env.DB),
						bucket: env.R2_BUCKET,
					}),
				};
			});
		}

		if (fleetEnabled && maintenanceIsDue("tedi-access-key-rotation", event)) {
			const { runTediAccessKeyRotationTick } =
				await import("./tedi-access-key-rotation");
			await trackPlatformCronPath(env, event, "tedi-access-key-rotation", () =>
				runTediAccessKeyRotationTick(env, runId),
			);
		}

		if (fleetEnabled && maintenanceIsDue("mcp-scan", event)) {
			const { runMcpScan } = await import("./catalog-scan-cron");
			await trackPlatformCronPath(env, event, "mcp-scan", () =>
				runMcpScan(env, runId),
			);
		}

		if (fleetEnabled && maintenanceIsDue("site-reconciliation", event)) {
			const { runSiteReconciliationTick } =
				await import("./site-reconciliation");
			await trackPlatformCronPath(env, event, "site-reconciliation", () =>
				runSiteReconciliationTick(env),
			);
		}

		if (fleetEnabled && maintenanceIsDue("tool-test-and-quality", event)) {
			const { runToolTestAndQualityScores } =
				await import("./catalog-scan-cron");
			await trackPlatformCronPath(env, event, "tool-test-and-quality", () =>
				runToolTestAndQualityScores(env, runId),
			);
		}

		// Platform-owned per-tenant weekly jobs are retired: a tenant's own cron
		// on its tedi owns the schedule, and the skill's executable workflow
		// self-fetches its export from the tedi's Artifacts repo.

		if (fleetEnabled && maintenanceIsDue("platform-health-digest", event)) {
			const { runPlatformHealthDigestTick } =
				await import("./platform-health-digest");
			await trackPlatformCronPath(env, event, "platform-health-digest", () =>
				runPlatformHealthDigestTick(env, event, runId),
			);
		}

		if (fleetEnabled && maintenanceIsDue("cost-anomaly-check", event)) {
			const { runCostAnomalyCheck } = await import("./cost-anomaly");
			await trackPlatformCronPath(env, event, "cost-anomaly-check", () =>
				runCostAnomalyCheck(env, runId),
			);
		}

		if (maintenanceIsDue("content-sync", event)) {
			const { runContentSync } = await import("./catalog-scan-cron");
			await trackPlatformCronPath(env, event, "content-sync", () =>
				runContentSync(env, runId),
			);
		}

		if (maintenanceIsDue("factory-weight-update", event)) {
			const { createDbClient } = await import("@tedix/db/client");
			const { updateFactoryWeights } = await import("./factory-weight-update");
			await trackPlatformCronPath(env, event, "factory-weight-update", () =>
				updateFactoryWeights(
					createDbClient(env.DB),
					new Date(event.scheduledTime),
				),
			);
		}

		// Daily decision-capture heartbeat. Fleet-gated only for the platform
		// killswitch (disabled mode does no scheduled DB work).
		if (fleetEnabled && maintenanceIsDue("capture-health-heartbeat", event)) {
			const { runCaptureHealthHeartbeat } = await import("./capture-health");
			await trackPlatformCronPath(env, event, "capture-health-heartbeat", () =>
				runCaptureHealthHeartbeat(env, event.scheduledTime),
			);
		}

		// Hourly: external-agent MCP clients accrue for every tenant with coding
		// agents, and expired-token orphans must drain far faster than they mint.
		// Gated on fleet-enabled only to honor the platform killswitch (disabled
		// mode does no scheduled DB work); production runs co-located, so this
		// runs there. No-op when Descope management creds are absent.
		if (
			fleetEnabled &&
			maintenanceIsDue("external-agent-mcp-client-reaper", event)
		) {
			const { runExternalAgentMcpClientReaperTick } =
				await import("./external-agent-mcp-client-reaper");
			await trackPlatformCronPath(
				env,
				event,
				"external-agent-mcp-client-reaper",
				() => runExternalAgentMcpClientReaperTick(env, runId),
			);
		}

		// Project recurring Work: one item per template and month, idempotent.
		if (fleetEnabled && maintenanceIsDue("recurring-work", event)) {
			const { fileRecurringWork } = await import("./recurring-work");
			const { createDbClient } = await import("@tedix/db/client");
			await trackPlatformCronPath(env, event, "recurring-work", () =>
				fileRecurringWork(
					createDbClient(env.DB),
					new Date(event.scheduledTime),
				),
			);
		}
	} catch (error) {
		console.error(
			`[Scheduled] Cron execution failed: cron=${cron}, scheduledTime=${new Date(event.scheduledTime).toISOString()}`,
			{ exception: safeExceptionTopology(error) },
		);
		throw error; // Re-throw to mark the scheduled event as failed
	} finally {
		// Keep the final batch inside the invocation's db.request ledger.
		await Promise.allSettled(backgroundPaths);
	}
};

export const scheduled: ExportedHandlerScheduledHandler<CloudflareEnv> = async (
	event,
	env,
	ctx,
) => {
	if (event.cron !== "*/2 * * * *") return dispatchScheduled(event, env, ctx);
	const { withPlatformCronReceipts } = await import("./platform-cron-receipts");
	return withPlatformCronReceipts(env, () =>
		dispatchScheduled(event, env, ctx),
	);
};
