import { describe, expect, it } from "vite-plus/test";
import {
	nextSkillScheduleFireAt,
	readSkillSchedulePolicy,
	validateSkillSchedulePolicy,
} from "./skill-schedule";

const SKILL = `---
name: weekly-report
capabilities:
  schedule:
    cron: "0 8 * * 1"
    params:
      region: de
    enabled: true
---
# Weekly report`;

describe("skill-native schedule", () => {
	it("parses and computes the next UTC fire", () => {
		expect(readSkillSchedulePolicy(SKILL)).toEqual({
			cron: "0 8 * * 1",
			params: { region: "de" },
			enabled: true,
			executionKind: "deterministic",
		});
		expect(nextSkillScheduleFireAt("0 8 * * 1", "2026-07-16T10:00:00Z")).toBe(
			"2026-07-20T08:00:00.000Z",
		);
	});

	it("requires an explicit inference execution kind", () => {
		const source = SKILL.replace(
			"enabled: true",
			"enabled: true\n    executionKind: inference",
		);
		expect(readSkillSchedulePolicy(source)?.executionKind).toBe("inference");
		expect(
			validateSkillSchedulePolicy(
				source.replace("executionKind: inference", "executionKind: expensive"),
			).issues,
		).toEqual([
			expect.objectContaining({
				path: "capabilities.schedule.executionKind",
			}),
		]);
	});

	it("supports lists, ranges, and steps", () => {
		expect(
			nextSkillScheduleFireAt("*/15 8-9 * * 1,3", "2026-07-20T08:01:00Z"),
		).toBe("2026-07-20T08:15:00.000Z");
	});

	it("supports leap-day schedules without a minute-by-minute multi-year scan", () => {
		expect(nextSkillScheduleFireAt("0 0 29 2 *", "2025-03-01T00:00:00Z")).toBe(
			"2028-02-29T00:00:00.000Z",
		);
	});

	it("rejects malformed schedules at write time", () => {
		const result = validateSkillSchedulePolicy(`---
capabilities:
  schedule:
    cron: "61 25 * * *"
    params: nope
---`);
		expect(result.schedule).toBeNull();
		expect(result.issues.map(({ path }) => path)).toEqual([
			"capabilities.schedule.cron",
			"capabilities.schedule.params",
		]);
	});
});
