import { describe, expect, it } from "vite-plus/test";
import {
	buildMissionObjectiveTitle,
	scoreMissionTextOverlap,
} from "./mission-text";

describe("mission text", () => {
	it("builds a bounded objective title from the first sentence", () => {
		expect(buildMissionObjectiveTitle("  fix the API. Then deploy it.  ")).toBe(
			"Fix the API",
		);
	});

	it("scores normalized meaningful-token overlap", () => {
		expect(scoreMissionTextOverlap("Deploy API worker", "deploy the API")).toBe(
			2 / 3,
		);
	});
});
