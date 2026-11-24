import { nextSkillScheduleFireAt } from "@tedix/api-contract/utils/cron-schedule";
import {
	MAINTENANCE_CRONS,
	MAINTENANCE_TRIGGER,
	maintenanceIsDue,
} from "./staggered-maintenance";
import { describe, expect, it, vi } from "vite-plus/test";
import { PlatformCronHealthResponseSchema } from "@tedix/api-contract/contracts/control-plane";
import { runMcpEventWebhookDelivery } from "./mcp-event-webhooks";
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
	it("keeps a full UTC day of maintenance starts apart from each other, labelling and billing", () => {
		const start = Date.UTC(2026, 10, 25);
		const end = start + 86_400_000;
		const starts = new Map<number, string>();
		for (const [id, cron] of Object.entries(MAINTENANCE_CRONS)) {
			let at = Date.parse(nextSkillScheduleFireAt(cron, start - 1));
			let count = 0;
			while (at < end) {
				expect(
					starts.get(at),
					`${id} collides at ${new Date(at).toISOString()}`,
				).toBeUndefined();
				expect(new Date(at).getUTCMinutes() % 2).toBe(1);
				expect(new Date(at).getUTCMinutes() % 15).not.toBe(0);
				starts.set(at, id);
				expect(
					maintenanceIsDue(id as keyof typeof MAINTENANCE_CRONS, {
						cron: MAINTENANCE_TRIGGER,
						scheduledTime: at,
					}),
				).toBe(true);
				expect(
					maintenanceIsDue(id as keyof typeof MAINTENANCE_CRONS, {
						cron: "0 * * * *",
						scheduledTime: at,
					}),
				).toBe(false);
				count++;
				at = Date.parse(nextSkillScheduleFireAt(cron, at));
			}
			const definition = PLATFORM_CRON_DEFINITIONS.find((d) => d.id === id)!;
			expect(definition.cron).toBe(cron);
			expect(count).toBe(
				id === "d1-retention"
					? 96
					: Math.round(1440 / definition.intervalMinutes),
			);
		}
	});

	it("keeps provider notification maintenance available in self-hosted installations", () => {
		expect(
			PLATFORM_CRON_DEFINITIONS.find(
				(definition) => definition.id === "provider-event-maintenance",
			),
		).toEqual({
			id: "provider-event-maintenance",
			cron: "*/2 * * * *",
			intervalMinutes: 2,
		});
	});
	it("reports the six-minute stall recovery interval on the shared two-minute trigger", () => {
		expect(
			PLATFORM_CRON_DEFINITIONS.find(
				(definition) => definition.id === "stall-recovery",
			),
		).toMatchObject({
			cron: "*/2 * * * *",
			intervalMinutes: 6,
			requiresBinding: "TEDI_SERVICE",
		});
	});
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

	it("reports the durable replay checkpoint independently of a terminal receipt", () => {
		const checkpoint = "2026-10-17T12:38:00.000Z";
		const health = PlatformCronHealthResponseSchema.parse(
			buildPlatformCronHealth({
				env,
				now,
				summaries: [],
				replayCheckpoints: { "commitment-wakes": checkpoint },
			}),
		);
		expect(
			health.schedules.find((row) => row.id === "commitment-wakes")
				?.replayCheckpointAt,
		).toBe(checkpoint);
		expect(
			health.schedules.find((row) => row.id === "stall-recovery")
				?.replayCheckpointAt,
		).toBeNull();
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

describe("MCP event webhook delivery tick", () => {
	it("wakes the MCP Worker's delivery pass over the service binding", async () => {
		const fetch = vi.fn(async (request: Request) => {
			expect(new URL(request.url).pathname).toBe("/__internal/events/deliver");
			expect(request.headers.get("X-Service-Binding")).toBe("true");
			return Response.json({ ok: true, claimed: 2, delivered: 1, idle: 1 });
		});
		expect(
			await runMcpEventWebhookDelivery({
				MCP_SERVICE: { fetch },
			} as unknown as CloudflareEnv),
		).toEqual({ claimed: 2, delivered: 1, idle: 1 });
	});

	it("fails the cron receipt when the pass is unavailable", async () => {
		await expect(
			runMcpEventWebhookDelivery({
				MCP_SERVICE: { fetch: async () => new Response(null, { status: 503 }) },
			} as unknown as CloudflareEnv),
		).rejects.toThrow("503");
	});

	it("runs on the existing two-minute trigger behind the MCP binding", () => {
		expect(
			PLATFORM_CRON_DEFINITIONS.find(
				(definition) => definition.id === "mcp-event-webhook-delivery",
			),
		).toEqual({
			id: "mcp-event-webhook-delivery",
			cron: "*/2 * * * *",
			intervalMinutes: 2,
			requiresBinding: "MCP_SERVICE",
		});
	});
});
