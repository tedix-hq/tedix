import { nextSkillScheduleFireAt } from "@tedix/api-contract/utils/cron-schedule";

// Odd-minute maintenance stays off the frequent even-minute installation tick.
export const MAINTENANCE_TRIGGER = "1-59/2 * * * *";
export const MAINTENANCE_CRONS = {
	"decision-outcome-labeller": "1,31 * * * *",
	"card-summary-backfill": "21,51 * * * *",
	"mcp-scan": "35 1 * * *",
	"site-reconciliation": "3 * * * *",
	"external-agent-mcp-client-reaper": "5 * * * *",
	"recurring-work": "7 * * * *",
	"conversation-title-backfill": "9 * * * *",
	"site-versions": "13 2 * * *",
	"daily-billing-and-catalog-maintenance": "17 2 * * *",
	"cloudflare-billable-usage": "19 2 * * *",
	"gateway-cost-reconciliation": "23 2 * * *",
	"output-asset-gc": "13 3 * * *",
	"tedi-access-key-rotation": "19 3 * * *",
	"retention-cleanup": "23 3 * * *",
	"memory-reflection-and-enrichment": "13 4 * * *",
	"tool-test-and-quality": "13 6 * * *",
	"content-sync": "13 7 * * *",
	"factory-weight-update": "17 7 * * *",
	"capture-health-heartbeat": "19 7 * * *",
	"platform-health-digest": "13 8 * * *",
	"cost-anomaly-check": "13 9 * * *",
	"tedi-mcp-access-health": "25 */6 * * *",
	"active-provider-scan-and-drift": "29 */6 * * *",
	"d1-retention": "11,27,41,57 * * * *",
} as const;

export function maintenanceIsDue(
	id: keyof typeof MAINTENANCE_CRONS,
	event: Pick<ScheduledController, "cron" | "scheduledTime">,
): boolean {
	// Provider timestamps can include seconds; cron due decisions use UTC minutes.
	const scheduledMinute = Math.floor(event.scheduledTime / 60_000) * 60_000;
	return (
		event.cron === MAINTENANCE_TRIGGER &&
		Date.parse(
			nextSkillScheduleFireAt(MAINTENANCE_CRONS[id], scheduledMinute - 60_000),
		) === scheduledMinute
	);
}
