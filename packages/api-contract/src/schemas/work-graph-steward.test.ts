import { describe, expect, it } from "vite-plus/test";
import {
	GetWorkGraphHealthInputSchema,
	WorkGraphHealthReportSchema,
} from "./work-items";

const workItemId = "11111111-1111-4111-8111-111111111111";
const attemptId = "22222222-2222-4222-8222-222222222222";

describe("canonical work-graph steward contract", () => {
	it("reports idle accepted specs by disposition/readiness and expired attempts", () => {
		const result = WorkGraphHealthReportSchema.parse({
			orgId: "33333333-3333-4333-8333-333333333333",
			projectId: null,
			generatedAt: "2026-08-20T12:00:00.000Z",
			idleThresholdDays: 14,
			dupThreshold: 0.85,
			scannedCount: 1,
			duplicates: [],
			idleAccepted: [
				{
					workItemId,
					title: "Implement evidence review",
					disposition: "accepted",
					readiness: "dependencies_blocked",
					lastActivityAt: "2026-07-01T00:00:00.000Z",
					idleDays: 50,
					suggestedAction: "review_idle",
				},
			],
			naming: [],
			expiredAttempts: [
				{
					workItemId,
					attemptId,
					executorType: "external_agent",
					executorId: "codex",
					executorSessionId: "session-1",
					expiresAt: "2026-08-20T11:00:00.000Z",
					suggestedAction: "flag",
				},
			],
			counts: {
				duplicateClusters: 0,
				duplicateItems: 0,
				idleAccepted: 1,
				naming: 0,
				expiredAttempts: 1,
			},
			truncated: {
				scan: false,
				idleAccepted: false,
				expiredAttempts: false,
			},
		});

		expect(result.idleAccepted[0]?.readiness).toBe("dependencies_blocked");
		expect(result.expiredAttempts[0]?.attemptId).toBe(attemptId);
	});

	it("rejects the retired stale and blocked-backlog report shape", () => {
		const result = WorkGraphHealthReportSchema.safeParse({
			orgId: "org",
			projectId: null,
			generatedAt: "2026-08-20T12:00:00.000Z",
			staleDays: 14,
			dupThreshold: 0.85,
			scannedCount: 0,
			duplicates: [],
			stale: [],
			naming: [],
			orphans: [],
			blockedBacklog: { total: 0 },
			counts: {},
			truncated: {},
		});

		expect(result.success).toBe(false);
	});

	it("names the idle observation horizon explicitly", () => {
		expect(GetWorkGraphHealthInputSchema.parse({})).toMatchObject({
			idleThresholdDays: 14,
		});
	});
});
