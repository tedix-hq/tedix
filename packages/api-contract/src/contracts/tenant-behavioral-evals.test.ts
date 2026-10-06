import { describe, expect, it } from "vite-plus/test";
import { tenantBehavioralEvalsContract } from "./tenant-behavioral-evals";
describe("tenantBehavioralEvals contract", () => {
	it("exposes the bounded diagnostic lifecycle", () => {
		expect(Object.keys(tenantBehavioralEvalsContract)).toEqual([
			"create",
			"revise",
			"get",
			"list",
			"startRun",
			"advanceRun",
			"getRun",
			"listRuns",
		]);
	});
});
