import { describe, expect, it } from "vite-plus/test";
import { parseDocument } from "yaml";
import { setFactoryScheduleEnabled } from "./factory-lifecycle";

describe("factory schedule revisions", () => {
	it("preserves cadence, params, neighboring enabled keys and body across pause/resume", () => {
		const content =
			'---\nname: sample-factory\ncapabilities:\n  other:\n    enabled: false\n  schedule:\n    cron: "17 8 * * *"\n    params:\n      enabled: true\n---\n# Body\nKeep this.\n';
		const paused = setFactoryScheduleEnabled(content, false);
		const policy = (s: string) =>
			parseDocument(s.split("---")[1]!).toJSON().capabilities;
		expect(policy(paused).schedule).toEqual({
			cron: "17 8 * * *",
			params: { enabled: true },
			enabled: false,
		});
		const resumed = setFactoryScheduleEnabled(paused, true);
		expect(policy(resumed)).toEqual(policy(content));
		expect(resumed.split("---")[2]).toBe(content.split("---")[2]);
	});
	it("rejects malformed or unscheduled lanes", () => {
		expect(() => setFactoryScheduleEnabled("# Missing", false)).toThrow();
		expect(() =>
			setFactoryScheduleEnabled("---\nname: sample\n---\n", true),
		).toThrow();
	});
});
