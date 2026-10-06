import { describe, expect, it } from "vite-plus/test";
import { CronExecutionSchema } from "./flywheel-health";

describe("CronExecutionSchema", () => {
	it("preserves execution and budget evidence for fleet health views", () => {
		const parsed = CronExecutionSchema.parse({
			name: "brain-reflection",
			mechanism: "scheduled_skill_workflow",
			lastRunId: "run-123",
			lastExecutedAt: "2026-08-01T12:00:00.000Z",
			lastSuccess: null,
			executionsLast24h: 3,
			expectedIntervalHours: 6,
			overdue: false,
			state: "budget_blocked",
			budgetBlockedAt: "2026-08-01T12:00:00.000Z",
			budgetBlockedReason: "Monthly learning budget exhausted",
			budgetResetAt: "2026-08-02T00:00:00.000Z",
			budgetBlockActive: true,
			budgetAdmissionClass: "governed_learning",
		});

		expect(parsed).toMatchObject({
			state: "budget_blocked",
			mechanism: "scheduled_skill_workflow",
			lastRunId: "run-123",
			budgetBlockActive: true,
		});
	});

	it("does not collapse failures into a generic overdue flag", () => {
		const result = CronExecutionSchema.safeParse({
			name: "objective-review",
			mechanism: "scheduled_skill_workflow",
			lastRunId: "run-456",
			lastExecutedAt: "2026-08-01T11:00:00.000Z",
			lastSuccess: false,
			executionsLast24h: 1,
			expectedIntervalHours: 24,
			overdue: false,
			state: "failed",
			budgetBlockedAt: null,
			budgetBlockedReason: null,
			budgetResetAt: null,
			budgetBlockActive: false,
			budgetAdmissionClass: null,
		});

		expect(result.success).toBe(true);
		if (result.success) expect(result.data.state).toBe("failed");
	});
});
