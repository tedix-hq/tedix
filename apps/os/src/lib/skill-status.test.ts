import { describe, expect, it } from "vite-plus/test";
import { skillStatus } from "./skill-status";

describe("skillStatus", () => {
	it("is Active for a skill that is on", () => {
		expect(skillStatus({ lifecycleState: "proven" }, null).label).toBe(
			"Active",
		);
	});
	it("is a Draft when it has not run", () => {
		const status = skillStatus(
			{ lifecycleState: "draft" },
			{ kind: "never_run", title: "It has not run yet" },
		);
		expect(status).toMatchObject({
			label: "Draft",
			reason: "It has not run yet",
		});
	});
	it("is Off after failed runs and says why", () => {
		const status = skillStatus(
			{ lifecycleState: "draft" },
			{ kind: "failed_runs", title: "Turned off after 3 failed runs" },
		);
		expect(status).toMatchObject({
			label: "Off",
			reason: "Turned off after 3 failed runs",
		});
	});
});
