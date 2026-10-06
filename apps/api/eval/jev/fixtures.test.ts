import { describe, expect, it } from "vite-plus/test";
import { gradeJevFixture, JEV_FIXTURES } from "./fixtures";

describe("synthetic Jev grading", () => {
	it("does not count an empty or wrongly typed answer as correctness", () => {
		for (const fixture of JEV_FIXTURES) {
			expect(gradeJevFixture(fixture, {})).toBe(false);
		}
		expect(
			gradeJevFixture(JEV_FIXTURES[0]!, {
				urgent: { type: "noul", noul: 0.1 },
			}),
		).toBe(false);
		expect(
			gradeJevFixture(JEV_FIXTURES[0]!, {
				urgent: { type: "noul", noul: 0.95 },
			}),
		).toBe(true);
	});
	it("requires the expected category, not merely a valid response", () => {
		const fixture = JEV_FIXTURES.find(({ id }) => id === "department-choice")!;
		expect(
			gradeJevFixture(fixture, {
				department: {
					type: "choice",
					choice: "engineering",
					probabilities: { engineering: 1 },
					confidence: 1,
				},
			}),
		).toBe(false);
	});
});
