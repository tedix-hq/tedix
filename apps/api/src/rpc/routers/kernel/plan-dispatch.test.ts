import { describe, expect, it } from "vite-plus/test";
import { detectsHomePlanningRequest } from "./plan-dispatch";

describe("Home planning request intent", () => {
	it.each([
		"Create exactly one new Proposed work item",
		"Please create a small test work item",
		"Add a work-item",
		"Open 2 proposed work items",
		"File a work-board issue",
	])("keeps %s on the tool-write route despite its description", (request) => {
		expect(
			detectsHomePlanningRequest(
				`${request} in the existing Launch project. Do not use the Research project.\n\nTitle: Review the rollout\nDescription: Plan code changes and coordinate a review across Research and Code Reviewer.`,
			),
		).toBe(false);
	});

	it.each([
		"Plan work items for Research and Code Reviewer.",
		"Create a plan to split work items across Research and Code Reviewer.",
		"Coordinate the launch across Research and Code Reviewer.",
		"Have Research write the brief and assign Code Reviewer the review.",
	])("preserves an explicit planning request: %s", (request) => {
		expect(detectsHomePlanningRequest(request)).toBe(true);
	});
});
