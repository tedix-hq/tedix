import { describe, expect, it } from "vite-plus/test";
import { workSchedulerContractRouter } from "./work-scheduler";

describe("Work scheduler router", () => {
	it("mounts ready-list and execution-cluster projections", () => {
		expect(Object.keys(workSchedulerContractRouter)).toEqual([
			"listReady",
			"planClusters",
		]);
	});
});
