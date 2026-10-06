import { describe, expect, it } from "vite-plus/test";
import {
	buildPlatformCronHealth,
	PLATFORM_CRON_DEFINITIONS,
	PLATFORM_CRON_IDS,
} from "./platform-cron-catalog";

const now = new Date("2026-08-09T04:46:00.000Z");
const env = {
	TEDIX_FLEET_AUTHORITY_MODE: "co-located",
	TEDI_SERVICE: {},
	TEDI_MCP_ACCESS_HEALTH_WORKFLOW: {},
} as unknown as CloudflareEnv;

describe("platform cron health", () => {
	it("defines every dispatcher id exactly once", () => {
		const defined = PLATFORM_CRON_DEFINITIONS.map(
			(definition) => definition.id,
		);
		expect(new Set(defined).size).toBe(defined.length);
		expect(new Set(defined)).toEqual(new Set(PLATFORM_CRON_IDS));
	});
	it("tracks the bounded gateway catch-up on the existing fleet-gated trigger", () => {
		expect(
			PLATFORM_CRON_DEFINITIONS.find(
				(definition) => definition.id === "gateway-cost-catchup",
			),
		).toMatchObject({
			cron: "*/2 * * * *",
			intervalMinutes: 2,
			requiresFleet: true,
		});
	});
	it("keeps a historical failure visible without making a fresh success current attention", () => {
		const health = buildPlatformCronHealth({
			env,
			now,
			summaries: [
				{
					scheduleId: "billing-and-gateway-cost",
					latestId: "receipt-success",
					latestStatus: "success",
					latestScheduledAt: "2026-08-09T04:45:00.000Z",
					latestStartedAt: "2026-08-09T04:45:01.000Z",
					latestFinishedAt: "2026-08-09T04:45:03.000Z",
					latestDurationMs: 2_000,
					latestAffectedRowCounts: { ingested: 13 },
					latestError: null,
					lastSuccessAt: "2026-08-09T04:45:03.000Z",
					lastFailureAt: "2026-08-09T04:30:03.000Z",
				},
			],
		});
		const billing = health.schedules.find(
			(schedule) => schedule.id === "billing-and-gateway-cost",
		);
		expect(billing).toMatchObject({
			state: "healthy",
			attention: false,
			lastFailureAt: "2026-08-09T04:30:03.000Z",
			nextExpectedAt: "2026-08-09T05:00:00.000Z",
		});
	});

	it("excludes intentional fleet opt-outs from current attention", () => {
		const health = buildPlatformCronHealth({
			env: {
				...env,
				TEDIX_FLEET_AUTHORITY_MODE: "disabled",
			} as unknown as CloudflareEnv,
			now,
			summaries: [],
		});
		const billing = health.schedules.find(
			(schedule) => schedule.id === "billing-and-gateway-cost",
		);
		expect(billing).toMatchObject({
			state: "disabled",
			attention: false,
			optOutReason: "Fleet authority is intentionally disabled",
		});
	});
});
