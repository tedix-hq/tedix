import { describe, expect, it } from "vite-plus/test";
import {
	assertScheduleEditAuthority,
	skillSchedulePolicyChanged,
} from "./cognitive-shared";

/**
 * Owner-only guard for capabilities.schedule edits: a free-text agent turn
 * must not be able to disable scheduled skills it does not own. Allowlist —
 * fails closed on every unproven identity.
 */

const doc = (schedule: string) => `---
name: x
capabilities:
${schedule}  mcp:
    tedi:
      - run_tedi_turn
---
# X
body prose
`;

const SCHEDULED = doc(
	`  schedule:\n    cron: "0 5 * * *"\n    enabled: true\n    params:\n      tediId: "t-owner"\n`,
);
const DISABLED = doc(
	`  schedule:\n    cron: "0 5 * * *"\n    enabled: false\n    params:\n      tediId: "t-owner"\n`,
);
const UNSCHEDULED = doc("");

describe("skillSchedulePolicyChanged", () => {
	it("detects enabled flips, cron changes, add and remove", () => {
		expect(skillSchedulePolicyChanged(SCHEDULED, DISABLED)).toBe(true);
		expect(
			skillSchedulePolicyChanged(
				SCHEDULED,
				SCHEDULED.replace("0 5 * * *", "0 6 * * *"),
			),
		).toBe(true);
		expect(skillSchedulePolicyChanged(UNSCHEDULED, SCHEDULED)).toBe(true);
		expect(skillSchedulePolicyChanged(SCHEDULED, UNSCHEDULED)).toBe(true);
	});

	it("ignores prose and formatting churn (structural comparison)", () => {
		expect(
			skillSchedulePolicyChanged(
				SCHEDULED,
				SCHEDULED.replace("body prose", "totally different prose"),
			),
		).toBe(false);
		expect(skillSchedulePolicyChanged(SCHEDULED, SCHEDULED)).toBe(false);
		expect(skillSchedulePolicyChanged(UNSCHEDULED, UNSCHEDULED)).toBe(false);
	});

	it("treats param reordering as unchanged (canonical params)", () => {
		const a = doc(
			`  schedule:\n    cron: "0 5 * * *"\n    enabled: true\n    params:\n      a: "1"\n      b: "2"\n`,
		);
		const b = doc(
			`  schedule:\n    cron: "0 5 * * *"\n    enabled: true\n    params:\n      b: "2"\n      a: "1"\n`,
		);
		expect(skillSchedulePolicyChanged(a, b)).toBe(false);
	});
});

describe("assertScheduleEditAuthority", () => {
	const entry = { id: "skill-1", owningTediId: "t-owner" };

	it("allows a signed-in human (operator authority)", () => {
		expect(() =>
			assertScheduleEditAuthority(
				{ authType: "user", user: { sub: "U1" } as never, tediId: undefined },
				entry,
			),
		).not.toThrow();
	});

	it("allows an operator API key", () => {
		expect(() =>
			assertScheduleEditAuthority(
				{ authType: "apikey", user: undefined, tediId: undefined },
				entry,
			),
		).not.toThrow();
	});

	it("allows the OWNING tedi", () => {
		expect(() =>
			assertScheduleEditAuthority(
				{ authType: "tedi", user: undefined, tediId: "t-owner" },
				entry,
			),
		).not.toThrow();
	});

	it("rejects a DIFFERENT tedi (the incident shape)", () => {
		expect(() =>
			assertScheduleEditAuthority(
				{ authType: "tedi", user: undefined, tediId: "t-helpful-stranger" },
				entry,
			),
		).toThrowError(/SKILL_SCHEDULE_OWNER_ONLY/);
	});

	it("rejects a non-owner even via trusted service binding identity", () => {
		expect(() =>
			assertScheduleEditAuthority(
				{
					authType: "service-binding",
					user: undefined,
					tediId: "t-helpful-stranger",
				},
				entry,
			),
		).toThrowError(/SKILL_SCHEDULE_OWNER_ONLY/);
	});

	it("rejects every anonymous machine identity (fails closed)", () => {
		for (const authType of [
			"tedi",
			"m2m",
			"service",
			"service-binding",
			undefined,
		] as const) {
			expect(() =>
				assertScheduleEditAuthority(
					{ authType: authType as never, user: undefined, tediId: undefined },
					entry,
				),
			).toThrowError(/SKILL_SCHEDULE_OWNER_ONLY/);
		}
	});

	it("rejects a tedi touching an ownerless skill's schedule (no owner to match)", () => {
		expect(() =>
			assertScheduleEditAuthority(
				{ authType: "tedi", user: undefined, tediId: "t-any" },
				{ id: "skill-2", owningTediId: null },
			),
		).toThrowError(/SKILL_SCHEDULE_OWNER_ONLY/);
	});
});
