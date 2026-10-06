import { describe, expect, it } from "vite-plus/test";
import {
	GOVERNED_LEARNING_SCHEDULES,
	resolveEnabledGovernedLearningCronNames,
} from "./governed-learning";

describe("resolveEnabledGovernedLearningCronNames", () => {
	it("keeps the shared cognitive floor by default", () => {
		expect(resolveEnabledGovernedLearningCronNames({})).toEqual(
			new Set(GOVERNED_LEARNING_SCHEDULES.map((item) => item.name)),
		);
	});

	it("honors pack and per-tedi opt-outs", () => {
		const enabled = resolveEnabledGovernedLearningCronNames({
			policyPackDefinition: {
				cronPolicy: {
					disabledCognitiveCronNames: ["brain-reflection"],
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
