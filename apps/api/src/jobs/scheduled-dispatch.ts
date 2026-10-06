import { fleetAuthorityIsEnabled } from "../lib/fleet-authority";
import { safeExceptionTopology } from "../lib/safe-log-metadata";
import type { PlatformCronId } from "./platform-cron-catalog";

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
			}),
		);
	}
}

/**
 * Scheduled event handler for cron-triggered workflows.
 *
 * Cron schedule (from wrangler.jsonc). The two lists must stay in step: a
 * trigger with no branch below burns an invocation and does nothing, and a
 * branch with no trigger never fires.
 * (Cron literals containing a slash-star are spelled in words below: inside a
 * block comment they would close it.)
 * - Every 2 minutes → graph projection drain + GDS redrive, due skill
 *   schedules, always-on keepalive, orphan-run sweep, work-attempt lease
 *   sweep, work approval redrive
 * - Every 15 minutes → AI Gateway cost-ledger tick, workstation lease reaper,
 *   workstation compute metering
 * - 0 * * * * (hourly) → MCP endpoint freshness scan (bounded 200-row
 *   workflow), site reconciliation, external-agent MCP client reaper, plus two
 *   hour-gated paths: platform-health digest (8am UTC) and cost-anomaly check
 *   (9am UTC)
 * - 0 2 * * * (2am UTC) → Legacy billing quarantine + catalog sync log maintenance
 * - 0 3 * * * (3am UTC) → Retention cleanup, catalog integrity, Claude registry
 * - 0 4 * * * (4am UTC) → Memory reflection (confidence decay, archive, edge discovery) + Catalog enrichment
 * - 0 6 * * * (6am UTC) → Tool testing and quality scores
 * - 0 7 * * * (7am UTC) → Content Sync
 * - Every 6h (0,6,12,18 UTC) → Tedi MCP access-health workflow (repair enabled)
 *   and upstream drift detection (forked tools vs catalog)
 *
 * Private tenant skills own supplier feeds; the Claude registry is a supplemental
 * official source.
 *
 * This module stays a thin dispatcher with only the fleet-authority seam as a
 * static import: every fleet-commercial schedule is gated behind
 * `fleetEnabled &&` BEFORE its job module is imported, which is what
 * scheduled-dispatch.test.ts proves against the authority classification.
 */
export const scheduled: ExportedHandlerScheduledHandler<CloudflareEnv> = async (
	event,
	env,
	ctx,
) => {
	const hour = new Date(event.scheduledTime).getUTCHours();
	const _minute = new Date(event.scheduledTime).getUTCMinutes();
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
			const {
				dispatchGraphProjectionDrains,
				redriveGraphGdsMaintenance,
				dispatchDueSkillSchedulesTick,
			} = await import("./platform-tick");
			await trackPlatformCronPath(env, event, "graph-projection-drain", () =>
				dispatchGraphProjectionDrains(env, event),
			);
			await trackPlatformCronPath(env, event, "graph-gds-redrive", () =>
				redriveGraphGdsMaintenance(env, event),
			);
			await trackPlatformCronPath(env, event, "skill-schedule-dispatch", () =>
				dispatchDueSkillSchedulesTick(env, event),
			);
		}

		if (cron === "*/2 * * * *" && env.TEDI_SERVICE) {
			const { runAlwaysOnKeepalive } = await import("./platform-tick");
			await trackPlatformCronPath(env, event, "always-on-keepalive", () =>
				runAlwaysOnKeepalive(env, ctx),
			);
		}

		if (cron === "*/2 * * * *") {
			const { sweepOrphanRunsTick } = await import("./platform-tick");
			await trackPlatformCronPath(env, event, "orphan-run-sweep", () =>
				sweepOrphanRunsTick(env),
			);
		}

		if (cron === "*/2 * * * *") {
			const { runWorkAttemptLeaseSweeperTick } =
				await import("./work-attempt-lease-sweeper");
			await trackPlatformCronPath(env, event, "work-attempt-lease-sweep", () =>
				runWorkAttemptLeaseSweeperTick(env, event.scheduledTime),
			);
		}

		if (fleetEnabled && cron === "*/2 * * * *") {
			// Separate from the 15-minute billing tick: catch up observations more
			// quickly without repeating settlement, credits, or Stripe side effects.
			const { createDbClient } = await import("@tedix/db/client");
			const { CATCHUP_PAGES_PER_RUN, ingestGatewayLogCosts } =
				await import("./gateway-cost-ingestion");
			await trackPlatformCronPath(
				env,
				event,
				"gateway-cost-catchup",
				async () => {
					const results = await ingestGatewayLogCosts(
						createDbClient(env.DB),
						env,
						{
							maxPagesPerGateway: CATCHUP_PAGES_PER_RUN,
						},
					);
					const failedGateways = results
						.filter((result) => result.failure)
						.map((result) => result.gatewayId);
					if (failedGateways.length > 0) {
						// Ingestion reports per-gateway failures instead of throwing so the
						// other gateway still runs. The cron receipt must nevertheless be
						// failed; otherwise an auth/write outage looks like healthy catch-up.
						throw new Error(
							`Gateway cost catch-up failed: ${failedGateways.join(", ")}`,
						);
					}
					return {
						ingested: results.reduce((sum, result) => sum + result.ingested, 0),
						skipped: results.reduce((sum, result) => sum + result.skipped, 0),
						contended: results.filter((result) => result.contended).length,
					};
				},
			);
		}

		if (cron === "*/2 * * * *" && env.TEDI_SERVICE) {
			const { dispatchWorkApprovalRedrives } =
				await import("./work-approval-redrive");
			await trackPlatformCronPath(env, event, "work-approval-redrive", () =>
				dispatchWorkApprovalRedrives(env, event.scheduledTime),
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

		if (
			fleetEnabled &&
			cron === "0 */6 * * *" &&
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

		if (fleetEnabled && cron === "0 2 * * *") {
			const { runDailyBillingAndCatalogMaintenance } =
				await import("./daily-billing-and-catalog-maintenance");
			await trackPlatformCronPath(
				env,
				event,
				"daily-billing-and-catalog-maintenance",
				() => runDailyBillingAndCatalogMaintenance(env, runId),
			);
			// Cloudflare refreshes billable usage daily, so this rides the
			// existing daily tick rather than adding a cron entry.
			const { runCloudflareBillableUsageTick } =
				await import("./cloudflare-billable-usage");
			await trackPlatformCronPath(env, event, "cloudflare-billable-usage", () =>
				runCloudflareBillableUsageTick(env),
			);
		}

		if (fleetEnabled && cron === "0 3 * * *") {
			const { runRetentionCleanupCron } = await import("./retention-cleanup");
			await trackPlatformCronPath(env, event, "retention-cleanup", () =>
				runRetentionCleanupCron(env, event, runId),
			);
			const { runMachineScopeDriftTick } =
				await import("./machine-scope-drift");
			await trackPlatformCronPath(env, event, "machine-scope-drift", () =>
				runMachineScopeDriftTick(env, runId),
			);
			const { runTediAccessKeyRotationTick } =
				await import("./tedi-access-key-rotation");
			await trackPlatformCronPath(env, event, "tedi-access-key-rotation", () =>
				runTediAccessKeyRotationTick(env, runId),
			);
		}

		if (fleetEnabled && cron === "0 4 * * *") {
			const { runMemoryReflectionAndEnrichment } =
				await import("./memory-reflection");
			await trackPlatformCronPath(
				env,
				event,
				"memory-reflection-and-enrichment",
				() => runMemoryReflectionAndEnrichment(env, runId),
			);
		}

		if (fleetEnabled && cron === "0 * * * *") {
			const { runMcpScan } = await import("./catalog-scan-cron");
			await trackPlatformCronPath(env, event, "mcp-scan", () =>
				runMcpScan(env, runId),
			);
		}

		if (fleetEnabled && cron === "0 * * * *") {
			const { runSiteReconciliationTick } =
				await import("./site-reconciliation");
			await trackPlatformCronPath(env, event, "site-reconciliation", () =>
				runSiteReconciliationTick(env),
			);
		}

		if (fleetEnabled && cron === "0 6 * * *") {
			const { runToolTestAndQualityScores } =
				await import("./catalog-scan-cron");
			await trackPlatformCronPath(env, event, "tool-test-and-quality", () =>
				runToolTestAndQualityScores(env, runId),
			);
		}

		// Platform-owned per-tenant weekly jobs are retired: a tenant's own cron
		// on its tedi owns the schedule, and the skill's executable workflow
		// self-fetches its export from the tedi's Artifacts repo.

		if (fleetEnabled && cron === "0 * * * *" && hour === 8) {
			const { runPlatformHealthDigestTick } =
				await import("./platform-health-digest");
			await trackPlatformCronPath(env, event, "platform-health-digest", () =>
				runPlatformHealthDigestTick(env, event, runId),
			);
		}

		if (fleetEnabled && cron === "0 * * * *" && hour === 9) {
			const { runCostAnomalyCheck } = await import("./cost-anomaly");
			await trackPlatformCronPath(env, event, "cost-anomaly-check", () =>
				runCostAnomalyCheck(env, runId),
			);
		}

		if (cron === "0 7 * * *") {
			const { runContentSync } = await import("./catalog-scan-cron");
			await trackPlatformCronPath(env, event, "content-sync", () =>
				runContentSync(env, runId),
			);
		}

		// Hourly: external-agent MCP clients accrue for every tenant with coding
		// agents, and expired-token orphans must drain far faster than they mint.
		// Gated on fleet-enabled only to honor the platform killswitch (disabled
		// mode does no scheduled DB work); production runs co-located, so this
		// runs there. No-op when Descope management creds are absent.
		if (fleetEnabled && cron === "0 * * * *") {
			const { runExternalAgentMcpClientReaperTick } =
				await import("./external-agent-mcp-client-reaper");
			await trackPlatformCronPath(
				env,
				event,
				"external-agent-mcp-client-reaper",
				() => runExternalAgentMcpClientReaperTick(env, runId),
			);
		}

		if (fleetEnabled && cron === "0 */6 * * *") {
			const { runActiveProviderScanAndDrift } =
				await import("./catalog-scan-cron");
			await trackPlatformCronPath(
				env,
				event,
				"active-provider-scan-and-drift",
				() => runActiveProviderScanAndDrift(env, runId),
			);
		}
	} catch (error) {
		console.error(
			`[Scheduled] Cron execution failed: cron=${cron}, scheduledTime=${new Date(event.scheduledTime).toISOString()}`,
			error,
		);
		throw error; // Re-throw to mark the scheduled event as failed
	}
};
