import { describe, expect, it } from "vite-plus/test";
import { resolveEnabledGovernedLearningCronNames } from "./governed-learning";

describe("resolveEnabledGovernedLearningCronNames", () => {
	it("has no implicit cognitive schedules", () => {
		expect(resolveEnabledGovernedLearningCronNames({})).toEqual(new Set());
	});

	it("lets a per-tedi opt-out suppress an explicitly configured pack template", () => {
		const enabled = resolveEnabledGovernedLearningCronNames({
			policyPackDefinition: {
				cronPolicy: {
					cronTemplates: [
						{
							name: "brain-reflection",
							schedule: "0 */8 * * *",
							message: "Review notes",
						},
					],
				},
			},
			runtimeOverrides: {
				cronPolicy: { disableCognitiveDefaults: true },
			},
		});
		expect(enabled).toEqual(new Set());
	});

	it("lets an explicit valid template or enabled skill schedule restore a loop", () => {
		const enabled = resolveEnabledGovernedLearningCronNames({
			policyPackDefinition: {
				cronPolicy: { disableCognitiveDefaults: true },
			},
			runtimeOverrides: {
				cronPolicy: {
					cronTemplates: [
						{
							name: "objective-review",
							schedule: "0 */4 * * *",
							message: "Review objectives",
						},
					],
				},
			},
			scheduledCronNames: ["grounding-review"],
		});
		expect(enabled).toEqual(new Set(["objective-review", "grounding-review"]));
	});
});
