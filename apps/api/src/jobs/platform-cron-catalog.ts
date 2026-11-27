import { MAINTENANCE_CRONS } from "./staggered-maintenance";
import { nextSkillScheduleFireAt } from "@tedix/api-contract/utils/cron-schedule";
import type { PlatformCronExecutionSummary } from "@tedix/db/queries/platform-cron-executions";

export type PlatformCronFreshnessState =
	| "healthy"
	| "running"
	| "failed"
	| "stale"
	| "missing"
	| "disabled";

export const PLATFORM_CRON_IDS = [
	"agent-session-event-drain",
	"agent-review-triage",
	"deck-pipeline-sweep",
	"factory-weight-update",
	"decision-outcome-labeller",
	"card-summary-backfill",
	"provider-event-maintenance",
	"graph-projection-drain",
	"skill-schedule-dispatch",
	"app-trigger-dispatch",
	"orphan-run-sweep",
	"delegated-run-deadline-sweep",
	"approval-expiry",
	"work-approval-redrive",
	"commitment-wakes",
	"agent-run-supervision",
	"tedi-memory-reflection",
	"stall-recovery",
	"repository-observer",
	"support-maintenance",
	"mcp-event-webhook-delivery",
	"work-attempt-lease-sweep",
	"work-due",
	"lane-stale",
	"outbound-review",
	"stale-delegation",
	"uncontracted-child",
	"work-maintenance",
	"audit-delivery",
	"owner-tool-queue",
	"orphan-workflow-cleanup",
	"kernel-request-reconcile",
	"interaction-review-dispatch",
	"always-on-keepalive",
	"billing-and-gateway-cost",
	"workstation-lease-reaper",
	"workstation-compute-metering",
	"tedi-mcp-access-health",
	"daily-billing-and-catalog-maintenance",
	"cloudflare-billable-usage",
	"gateway-cost-reconciliation",
	"output-asset-gc",
	"mcp-scan",
	"tool-test-and-quality",
	"content-sync",
	"platform-health-digest",
	"cost-anomaly-check",
	"external-agent-mcp-client-reaper",
	"recurring-work",
	"tedi-access-key-rotation",
	"site-reconciliation",
	"site-versions",
	"cms-template-upstream",
	"d1-retention",
	"capture-health-heartbeat",
	"dispatcher-health-alarm",
	"work-routing",
] as const;
export type PlatformCronId = (typeof PLATFORM_CRON_IDS)[number];

interface PlatformCronDefinition {
	id: PlatformCronId;
	cron: string;
	intervalMinutes: number;
	requiresFleet?: boolean;
	requiresBinding?:
		| "TEDI_SERVICE"
		| "TEDI_MCP_ACCESS_HEALTH_WORKFLOW"
		| "MCP_SERVICE";
}

const everyTwoMinuteIds = [
	"agent-session-event-drain",
	"provider-event-maintenance",
	"graph-projection-drain",
	"skill-schedule-dispatch",
	"app-trigger-dispatch",
	"orphan-run-sweep",
	"delegated-run-deadline-sweep",
	"approval-expiry",
	"work-attempt-lease-sweep",
	"work-due",
	"lane-stale",
	"outbound-review",
	"stale-delegation",
	"uncontracted-child",
	"work-maintenance",
	"audit-delivery",
	"owner-tool-queue",
	"orphan-workflow-cleanup",
	"kernel-request-reconcile",
	"interaction-review-dispatch",
] as const;
const everyTwoMinutes = everyTwoMinuteIds.map((id) => ({
	id,
	cron: "*/2 * * * *",
	intervalMinutes: 2,
}));

export const PLATFORM_CRON_DEFINITIONS: readonly PlatformCronDefinition[] = [
	...everyTwoMinutes,
	{
		id: "dispatcher-health-alarm",
		cron: "*/15 * * * *",
		intervalMinutes: 15,
	},
	{
		id: "decision-outcome-labeller",
		cron: MAINTENANCE_CRONS["decision-outcome-labeller"],
		intervalMinutes: 30,
	},
	{
		id: "card-summary-backfill",
		cron: MAINTENANCE_CRONS["card-summary-backfill"],
		intervalMinutes: 30,
	},
	{ id: "deck-pipeline-sweep", cron: "*/2 * * * *", intervalMinutes: 15 },
	{
		id: "agent-review-triage",
		cron: "*/15 * * * *",
		intervalMinutes: 15,
		requiresFleet: true,
		requiresBinding: "TEDI_SERVICE",
	},
	{
		id: "always-on-keepalive",
		cron: "*/2 * * * *",
		intervalMinutes: 2,
		requiresBinding: "TEDI_SERVICE",
	},
	{
		id: "work-approval-redrive",
		cron: "*/2 * * * *",
		intervalMinutes: 2,
		requiresBinding: "TEDI_SERVICE",
	},
	{
		id: "commitment-wakes",
		cron: "*/2 * * * *",
		intervalMinutes: 2,
		requiresBinding: "TEDI_SERVICE",
	},
	{
		id: "agent-run-supervision",
		cron: "*/2 * * * *",
		intervalMinutes: 2,
		requiresBinding: "TEDI_SERVICE",
	},
	{
		id: "tedi-memory-reflection",
		cron: "*/2 * * * *",
		intervalMinutes: 10,
	},
	{
		id: "stall-recovery",
		cron: "*/2 * * * *",
		intervalMinutes: 6,
		requiresBinding: "TEDI_SERVICE",
	},
	{
		id: "work-routing",
		cron: "*/2 * * * *",
		intervalMinutes: 10,
		requiresBinding: "TEDI_SERVICE",
	},
	{
		id: "repository-observer",
		cron: "*/2 * * * *",
		intervalMinutes: 2,
		requiresBinding: "TEDI_SERVICE",
	},
	{
		id: "support-maintenance",
		cron: "*/15 * * * *",
		intervalMinutes: 15,
		requiresBinding: "TEDI_SERVICE",
	},
	{
		id: "mcp-event-webhook-delivery",
		cron: "*/2 * * * *",
		intervalMinutes: 2,
		requiresBinding: "MCP_SERVICE",
	},
	...(
		[
			"billing-and-gateway-cost",
			"workstation-lease-reaper",
			"workstation-compute-metering",
		] as const
	).map((id) => ({
		id,
		cron: "*/15 * * * *",
		intervalMinutes: 15,
		requiresFleet: true,
	})),
	{
		id: "tedi-mcp-access-health",
		cron: MAINTENANCE_CRONS["tedi-mcp-access-health"],
		intervalMinutes: 360,
		requiresFleet: true,
		requiresBinding: "TEDI_MCP_ACCESS_HEALTH_WORKFLOW",
	},
	{
		id: "daily-billing-and-catalog-maintenance",
		cron: MAINTENANCE_CRONS["daily-billing-and-catalog-maintenance"],
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "cloudflare-billable-usage",
		cron: MAINTENANCE_CRONS["cloudflare-billable-usage"],
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "gateway-cost-reconciliation",
		cron: MAINTENANCE_CRONS["gateway-cost-reconciliation"],
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "output-asset-gc",
		cron: MAINTENANCE_CRONS["output-asset-gc"],
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "tedi-access-key-rotation",
		cron: MAINTENANCE_CRONS["tedi-access-key-rotation"],
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "mcp-scan",
		cron: MAINTENANCE_CRONS["mcp-scan"],
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "tool-test-and-quality",
		cron: MAINTENANCE_CRONS["tool-test-and-quality"],
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "content-sync",
		cron: MAINTENANCE_CRONS["content-sync"],
		intervalMinutes: 1_440,
	},
	{
		id: "factory-weight-update",
		cron: MAINTENANCE_CRONS["factory-weight-update"],
		intervalMinutes: 1_440,
	},
	{
		id: "capture-health-heartbeat",
		cron: MAINTENANCE_CRONS["capture-health-heartbeat"],
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "platform-health-digest",
		cron: MAINTENANCE_CRONS["platform-health-digest"],
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "cost-anomaly-check",
		cron: MAINTENANCE_CRONS["cost-anomaly-check"],
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "external-agent-mcp-client-reaper",
		cron: MAINTENANCE_CRONS["external-agent-mcp-client-reaper"],
		intervalMinutes: 60,
	},
	{
		id: "recurring-work",
		cron: MAINTENANCE_CRONS["recurring-work"],
		intervalMinutes: 60,
	},
	{
		id: "site-reconciliation",
		cron: MAINTENANCE_CRONS["site-reconciliation"],
		intervalMinutes: 60,
		requiresFleet: true,
	},
	{
		id: "site-versions",
		cron: MAINTENANCE_CRONS["site-versions"],
		intervalMinutes: 1440,
		requiresFleet: true,
	},
	{
		id: "cms-template-upstream",
		cron: MAINTENANCE_CRONS["cms-template-upstream"],
		intervalMinutes: 10_080,
		requiresFleet: true,
	},
	{
		id: "d1-retention",
		cron: MAINTENANCE_CRONS["d1-retention"],
		intervalMinutes: 16,
		requiresFleet: true,
	},
];

// `?to=/:account/` lets the dashboard pick the viewer's account, so the
// published source names no account id.
const CLOUDFLARE_API_OBSERVABILITY_URL =
	"https://dash.cloudflare.com/?to=/:account/workers/services/view/tedix-api/production/metrics";

function ageSeconds(at: string | null, nowMs: number): number | null {
	const ms = at ? Date.parse(at) : Number.NaN;
	return Number.isNaN(ms) ? null : Math.max(0, Math.round((nowMs - ms) / 1000));
}

export function buildPlatformCronHealth(input: {
	env: CloudflareEnv;
	summaries: PlatformCronExecutionSummary[];
	replayCheckpoints?: Partial<Record<PlatformCronId, string | null>>;
	dispatcher?: {
		lastAdmissionAt: string | null;
		lastTrackerActionAt: string | null;
	};
	now?: Date;
}) {
	const now = input.now ?? new Date();
	const nowMs = now.getTime();
	const byId = new Map(
		input.summaries.map((summary) => [summary.scheduleId, summary]),
	);
	const fleetEnabled =
		String(input.env.TEDIX_FLEET_AUTHORITY_MODE) !== "disabled";

	const schedules = PLATFORM_CRON_DEFINITIONS.map((definition) => {
		const summary = byId.get(definition.id) ?? null;
		const optOutReason =
			definition.id === "tedi-memory-reflection" &&
			!input.env.TEDI_SERVICE &&
			!fleetEnabled
				? "Memory reflection needs the tedi runtime or fleet authority"
				: !fleetEnabled && definition.requiresFleet
					? "Fleet authority is intentionally disabled"
					: definition.requiresBinding && !input.env[definition.requiresBinding]
						? `${definition.requiresBinding} is not configured`
						: null;
		const enabled = optOutReason === null;
		const graceMinutes = Math.max(
			5,
			Math.ceil(definition.intervalMinutes * 1.5),
		);
		const latestAgeMinutes = summary
			? Math.max(
					0,
					(nowMs - new Date(summary.latestScheduledAt).getTime()) / 60_000,
				)
			: null;
		let state: PlatformCronFreshnessState;
		if (!enabled) state = "disabled";
		else if (!summary) state = "missing";
		else if (summary.latestStatus === "failure") state = "failed";
		else if (latestAgeMinutes !== null && latestAgeMinutes > graceMinutes)
			state = "stale";
		else if (summary.latestStatus === "running") state = "running";
		else state = "healthy";

		return {
			id: definition.id,
			cron: definition.cron,
			enabled,
			optOutReason,
			state,
			attention: enabled && ["failed", "stale", "missing"].includes(state),
			nextExpectedAt: enabled
				? nextSkillScheduleFireAt(definition.cron, now)
				: null,
			freshnessGraceMinutes: graceMinutes,
			replayCheckpointAt: input.replayCheckpoints?.[definition.id] ?? null,
			latest: summary
				? {
						id: summary.latestId,
						status: summary.latestStatus,
						scheduledAt: summary.latestScheduledAt,
						startedAt: summary.latestStartedAt,
						finishedAt: summary.latestFinishedAt,
						durationMs: summary.latestDurationMs,
						affectedRowCounts: summary.latestAffectedRowCounts,
						error: summary.latestError,
					}
				: null,
			lastSuccessAt: summary?.lastSuccessAt ?? null,
			lastFailureAt: summary?.lastFailureAt ?? null,
			countsLast24h: summary?.countsLast24h ?? {
				running: 0,
				success: 0,
				failure: 0,
			},
			evidenceUrl: CLOUDFLARE_API_OBSERVABILITY_URL,
		};
	});
	return {
		generatedAt: now.toISOString(),
		attentionCount: schedules.filter((schedule) => schedule.attention).length,
		schedules,
		...(input.dispatcher
			? {
					dispatcher: {
						...input.dispatcher,
						admissionAgeSeconds: ageSeconds(
							input.dispatcher.lastAdmissionAt,
							nowMs,
						),
						trackerAgeSeconds: ageSeconds(
							input.dispatcher.lastTrackerActionAt,
							nowMs,
						),
					},
				}
			: {}),
	};
}
