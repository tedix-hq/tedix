import { describe, expect, it } from "vite-plus/test";
import { OfficeObservationSchema } from "./office-activity";

const observation = {
	id: "00000000-0000-4000-8000-000000000001",
	at: "2026-11-03T12:00:00.000Z",
	host: "codex",
	source: "hook",
	sessionKey: "codex:example",
	trigger: "Stop",
	reason: "reported",
	outcome: "observed",
	reporterVersion: "0.19.3",
};
describe("Office metadata privacy", () => {
	it("accepts only bounded metadata; raw host fields and free text never pass", () => {
		expect(OfficeObservationSchema.safeParse(observation).success).toBe(true);
		for (const key of [
			"prompt",
			"tool_input",
			"arguments",
			"transcript",
			"credentials",
			"error",
			"body",
			"ownerId",
			"organizationId",
		])
			expect(
				OfficeObservationSchema.safeParse({ ...observation, [key]: "secret" })
					.success,
			).toBe(false);
		for (const key of [
			"trigger",
			"reason",
			"outcome",
			"reporterVersion",
			"sessionKey",
		])
			expect(
				OfficeObservationSchema.safeParse({
					...observation,
					[key]: "raw prompt / secret",
				}).success,
			).toBe(false);
	});
});
