import { nextSkillScheduleFireAt } from "@tedix/api-contract/utils/skill-schedule";
import type { PlatformCronExecutionSummary } from "@tedix/db/queries/platform-cron-executions";

export type PlatformCronFreshnessState =
	| "healthy"
	| "running"
	| "failed"
	| "stale"
	| "missing"
	| "disabled";

export const PLATFORM_CRON_IDS = [
	"provider-event-maintenance",
	"graph-projection-drain",
	"graph-gds-redrive",
	"skill-schedule-dispatch",
	"orphan-run-sweep",
	"work-approval-redrive",
	"work-attempt-lease-sweep",
	"always-on-keepalive",
	"billing-and-gateway-cost",
	"gateway-cost-catchup",
	"workstation-lease-reaper",
	"workstation-compute-metering",
	"tedi-mcp-access-health",
	"daily-billing-and-catalog-maintenance",
	"cloudflare-billable-usage",
	"retention-cleanup",
	"memory-reflection-and-enrichment",
	"mcp-scan",
	"tool-test-and-quality",
	"content-sync",
	"platform-health-digest",
	"cost-anomaly-check",
	"active-provider-scan-and-drift",
	"external-agent-mcp-client-reaper",
	"machine-scope-drift",
	"tedi-access-key-rotation",
	"site-reconciliation",
	"reply-draft-career",
] as const;
export type PlatformCronId = (typeof PLATFORM_CRON_IDS)[number];

interface PlatformCronDefinition {
	id: PlatformCronId;
	cron: string;
	intervalMinutes: number;
	requiresFleet?: boolean;
	requiresBinding?: "TEDI_SERVICE" | "TEDI_MCP_ACCESS_HEALTH_WORKFLOW";
}

const everyTwoMinuteIds = [
	"provider-event-maintenance",
	"graph-projection-drain",
	"graph-gds-redrive",
	"skill-schedule-dispatch",
	"orphan-run-sweep",
	"work-attempt-lease-sweep",
] as const;
const everyTwoMinutes = everyTwoMinuteIds.map((id) => ({
	id,
	cron: "*/2 * * * *",
	intervalMinutes: 2,
}));

export const PLATFORM_CRON_DEFINITIONS: readonly PlatformCronDefinition[] = [
	...everyTwoMinutes,
	{
		id: "gateway-cost-catchup",
		cron: "*/2 * * * *",
		intervalMinutes: 2,
		requiresFleet: true,
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
	...(
		[
			"billing-and-gateway-cost",
			"workstation-lease-reaper",
			"workstation-compute-metering",
			"reply-draft-career",
		] as const
	).map((id) => ({
		id,
		cron: "*/15 * * * *",
		intervalMinutes: 15,
		requiresFleet: true,
	})),
	{
		id: "tedi-mcp-access-health",
		cron: "0 */6 * * *",
		intervalMinutes: 360,
		requiresFleet: true,
		requiresBinding: "TEDI_MCP_ACCESS_HEALTH_WORKFLOW",
	},
	{
		id: "daily-billing-and-catalog-maintenance",
		cron: "0 2 * * *",
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "cloudflare-billable-usage",
		cron: "0 2 * * *",
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "retention-cleanup",
		cron: "0 3 * * *",
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "machine-scope-drift",
		cron: "0 3 * * *",
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "tedi-access-key-rotation",
		cron: "0 3 * * *",
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "memory-reflection-and-enrichment",
		cron: "0 4 * * *",
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "mcp-scan",
		cron: "0 * * * *",
		intervalMinutes: 60,
		requiresFleet: true,
	},
	{
		id: "tool-test-and-quality",
		cron: "0 6 * * *",
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{ id: "content-sync", cron: "0 7 * * *", intervalMinutes: 1_440 },
	{
		id: "platform-health-digest",
		cron: "0 8 * * *",
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "cost-anomaly-check",
		cron: "0 9 * * *",
		intervalMinutes: 1_440,
		requiresFleet: true,
	},
	{
		id: "active-provider-scan-and-drift",
		cron: "0 */6 * * *",
		intervalMinutes: 360,
		requiresFleet: true,
	},
	{
		id: "external-agent-mcp-client-reaper",
		cron: "0 * * * *",
		intervalMinutes: 60,
	},
	{
		id: "site-reconciliation",
		cron: "0 * * * *",
		intervalMinutes: 60,
		requiresFleet: true,
	},
];

// `?to=/:account/` lets the dashboard pick the viewer's account, so the
// published source names no account id.
const CLOUDFLARE_API_OBSERVABILITY_URL =
	"https://dash.cloudflare.com/?to=/:account/workers/services/view/tedix-api-production/production/metrics";

export function buildPlatformCronHealth(input: {
	env: CloudflareEnv;
	summaries: PlatformCronExecutionSummary[];
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
			!fleetEnabled && definition.requiresFleet
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
			evidenceUrl: CLOUDFLARE_API_OBSERVABILITY_URL,
		};
	});
	return {
		generatedAt: now.toISOString(),
		attentionCount: schedules.filter((schedule) => schedule.attention).length,
		schedules,
	};
}
