import { describe, expect, it } from "vite-plus/test";
import { ProjectHealthJudgmentSchema } from "@tedix/api-contract/contracts/projects";
import { judgmentTargetAt } from "./projects";

describe("health judgment target", () => {
	it("turns the project's free-text target date into a datetime the output schema accepts", () => {
		expect(judgmentTargetAt("2026-08-31")).toBe("2026-08-31T00:00:00.000Z");
		expect(judgmentTargetAt("2026-08-31T12:00:00.000Z")).toBe(
			"2026-08-31T12:00:00.000Z",
		);
		expect(judgmentTargetAt("end of Q3")).toBeNull();
		expect(judgmentTargetAt(null)).toBeNull();
		expect(() =>
			ProjectHealthJudgmentSchema.parse({
				id: crypto.randomUUID(),
				orgId: crypto.randomUUID(),
				projectId: crypto.randomUUID(),
				health: "at_risk",
				summary: "s",
				judgedByType: "user",
				judgedById: "u",
				observedAt: new Date().toISOString(),
				targetAt: judgmentTargetAt("2026-08-31"),
			}),
		).not.toThrow();
	});
});
