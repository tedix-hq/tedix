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

	it.each([
		["5/15 * * * *", "2026-10-25T00:06:00Z", "2026-10-25T00:20:00.000Z"],
		["5/15 * * * *", "2026-10-25T00:50:00Z", "2026-10-25T01:05:00.000Z"],
		["59/1 * * * *", "2026-10-25T00:59:00Z", "2026-10-25T01:59:00.000Z"],
		["0 2/6 * * *", "2026-10-25T03:00:00Z", "2026-10-25T08:00:00.000Z"],
		["0 0 5/10 * *", "2026-10-06T00:00:00Z", "2026-10-15T00:00:00.000Z"],
		["0 0 1 2/3 *", "2026-03-01T00:00:00Z", "2026-05-01T00:00:00.000Z"],
		["0 0 * * 1/2", "2026-10-26T00:00:00Z", "2026-10-28T00:00:00.000Z"],
		["0 0 * * 5/2", "2026-10-30T00:00:00Z", "2026-11-01T00:00:00.000Z"],
		["5/15,10 * * * *", "2026-10-25T00:11:00Z", "2026-10-25T00:20:00.000Z"],
		["5-20/15 * * * *", "2026-10-25T00:20:00Z", "2026-10-25T01:05:00.000Z"],
		["5,10 * * * *", "2026-10-25T00:11:00Z", "2026-10-25T01:05:00.000Z"],
	])(
		"expands stepped values within field bounds for %s after %s",
		(cron, after, next) => {
			expect(nextSkillScheduleFireAt(cron, after)).toBe(next);
		},
	);

	it("supports lists, ranges, and steps", () => {
		expect(
			nextSkillScheduleFireAt("*/15 8-9 * * 1,3", "2026-07-20T08:01:00Z"),
		).toBe("2026-07-20T08:15:00.000Z");
	});

	it.each([
		["0 0 */2 * 1", "2026-10-24T00:00:00Z", "2026-11-09T00:00:00.000Z"],
		["0 0 27 * */2", "2026-10-24T00:00:00Z", "2026-10-27T00:00:00.000Z"],
		["0 0 27 * */2", "2026-10-27T00:00:00Z", "2026-12-27T00:00:00.000Z"],
		["0 0 */2 * */2", "2026-10-25T00:00:00Z", "2026-10-27T00:00:00.000Z"],
		["0 0 */2 * *", "2026-10-25T00:00:00Z", "2026-10-27T00:00:00.000Z"],
		["0 0 * * */2", "2026-10-25T00:00:00Z", "2026-10-27T00:00:00.000Z"],
	])(
		"intersects wildcard day constraints for %s after %s",
		(cron, after, next) => {
			expect(nextSkillScheduleFireAt(cron, after)).toBe(next);
		},
	);

	it.each([
		["0 0 13 * 1", "2026-10-26T00:00:00.000Z"],
		["0 0 25 * 1", "2026-10-25T00:00:00.000Z"],
	])("matches either restricted day field for %s", (cron, next) => {
		expect(nextSkillScheduleFireAt(cron, "2026-10-24T00:00:00Z")).toBe(next);
	});

	it("supports leap-day schedules without a minute-by-minute multi-year scan", () => {
		expect(nextSkillScheduleFireAt("0 0 29 2 *", "2025-03-01T00:00:00Z")).toBe(
			"2028-02-29T00:00:00.000Z",
		);
	});

	it("finds leap-day schedules across a non-leap century", () => {
		expect(nextSkillScheduleFireAt("0 0 29 2 *", "2096-03-01T00:00:00Z")).toBe(
			"2104-02-29T00:00:00.000Z",
		);
	});

	it("rejects impossible calendar dates after a bounded search", () => {
		expect(() =>
			nextSkillScheduleFireAt("0 0 30 2 *", "2096-03-01T00:00:00Z"),
		).toThrow("cron has no fire time within the next 400 years");
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

	it.each([
		"0/1/2 * * * *",
		"0,,1 * * * *",
		"0, * * * *",
		"0-1-2 * * * *",
		"-1 * * * *",
		"0- * * * *",
		"*/ * * * *",
		"1e1 * * * *",
		"0x1 * * * *",
		"*-5 * * * *",
	])("rejects the malformed cron token in %s at write time", (cron) => {
		expect(() =>
			nextSkillScheduleFireAt(cron, "2026-10-25T00:00:00Z"),
		).toThrow();
		const result = validateSkillSchedulePolicy(`---
capabilities:
  schedule:
    cron: "${cron}"
---`);
		expect(result.schedule).toBeNull();
		expect(result.issues.map(({ path }) => path)).toEqual([
			"capabilities.schedule.cron",
		]);
	});
});
