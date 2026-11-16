import { describe, expect, it } from "vite-plus/test";
import {
	plainRunError,
	recentRunTrend,
	skillDraftReason,
	type SkillDraftRun,
} from "./skill-draft-reason";

const workflow = { "scripts/workflow.ts": "export default {}" };
const draft = {
	lifecycleState: "draft" as const,
	revision: 7,
	revisionReasoning: null,
	tags: [],
	files: workflow,
};
let counter = 0;
const run = (
	status: SkillDraftRun["status"],
	skillRevision = 7,
	completedAt = "2026-11-07T06:00:00.000Z",
): SkillDraftRun => ({
	id: `run-${(counter += 1)}`,
	status,
	skillRevision,
	startedAt: completedAt,
	completedAt,
});

describe("why a skill is a draft", () => {
	it("says nothing for a skill that is on", () => {
		expect(
			skillDraftReason({
				skill: { ...draft, lifecycleState: "active" },
				runs: [],
				canTurnOn: true,
			}),
		).toBeNull();
	});

	it("names the failed runs, the date and the last error after three failures in a row", () => {
		const runs = [
			run("failed"),
			run("failed"),
			run("failed"),
			run("completed"),
		];
		const reason = skillDraftReason({
			skill: draft,
			runs,
			schedules: [{ enabled: false }],
			lastError: "Error: Mailbox token expired\n    at step (workflow.ts:4)",
			canTurnOn: true,
		})!;
		expect(reason.kind).toBe("failed_runs");
		expect(reason.title).toBe("Draft after 3 failed runs in a row");
		expect(reason.why[0]).toMatch(
			/^Its last 3 runs failed, most recently on Nov 7.*Tedix turns a skill off after 3 failed runs in a row/,
		);
		expect(reason.why).toContain("Last error: Mailbox token expired");
		expect(reason.why).toContain(
			"Its schedule is paused, so no scheduled runs start.",
		);
		expect(reason.lastFailedRunId).toBe(runs[0]!.id);
		expect(reason.testFirst).toBe(true);
		expect(reason.next).toEqual([
			"Open the failed run, see what went wrong and fix it.",
			"Run a test. Tedix normally turns a skill on only after a test run of this version has passed.",
			"Turn it back on.",
			"Open the Settings tab and turn the schedule back on if it is still paused.",
		]);
	});

	it("counts a longer streak and says when a fixed version has not run yet", () => {
		const reason = skillDraftReason({
			skill: { ...draft, revision: 8 },
			runs: [
				run("running", 8),
				run("failed"),
				run("failed"),
				run("failed"),
				run("failed"),
			],
			canTurnOn: true,
		})!;
		expect(reason.title).toBe("Draft after 4 failed runs in a row");
		expect(reason.why).toContain(
			"Revision 8 was saved after those runs and has not run yet.",
		);
	});

	it("does not blame failed runs for fewer than three failures", () => {
		const reason = skillDraftReason({
			skill: draft,
			runs: [run("failed"), run("failed"), run("completed")],
			lastError: "Sheet not found",
			canTurnOn: true,
		})!;
		expect(reason.kind).toBe("not_turned_on");
		expect(reason.why[0]).toMatch(
			/^Its latest run failed on Nov 7.*Tedix did not turn it off: that takes 3 failed runs in a row\.$/,
		);
		expect(reason.why).toContain("Last error: Sheet not found");
		expect(reason.testFirst).toBe(true);
	});

	it("says a skill that never ran is not turned on yet", () => {
		const reason = skillDraftReason({
			skill: draft,
			runs: [],
			canTurnOn: true,
		})!;
		expect(reason.kind).toBe("never_run");
		expect(reason.title).toBe("Draft: not turned on yet");
		expect(reason.why).toEqual([
			"A new skill starts as a draft. It has not run yet.",
		]);
		expect(reason.lastFailedRunId).toBeNull();
		expect(reason.next).toEqual([
			"Run a test. Tedix normally turns a skill on only after a test run of this version has passed.",
			"Turn it back on.",
		]);
	});

	it("says a changed or switched-off skill is a draft since its new revision, with the saved note", () => {
		const reason = skillDraftReason({
			skill: {
				...draft,
				revision: 9,
				revisionReasoning: "Paused while the supplier feed is rebuilt.",
			},
			runs: [run("completed", 8), run("completed", 8)],
			canTurnOn: true,
		})!;
		expect(reason.kind).toBe("changed");
		expect(reason.title).toBe("Draft since revision 9 was saved");
		expect(reason.why[0]).toMatch(
			/^Someone changed this skill or turned it off after its latest run on Nov 7/,
		);
		expect(reason.why).toContain(
			"Note saved with revision 9: Paused while the supplier feed is rebuilt.",
		);
		expect(reason.testFirst).toBe(true);
	});

	it("says a version that completed a run is simply not turned on", () => {
		const reason = skillDraftReason({
			skill: draft,
			runs: [run("completed"), run("failed")],
			canTurnOn: true,
		})!;
		expect(reason.kind).toBe("not_turned_on");
		expect(reason.why[0]).toMatch(
			/^Its latest run completed on Nov 7.*failed runs are not the reason/,
		);
		// The newest run of this version completed: a test is no longer first.
		expect(reason.testFirst).toBe(false);
		expect(reason.next).toEqual([
			"Run a test if this version has not passed one yet.",
			"Turn it back on.",
		]);
	});

	it("explains a paused schedule and where to turn it back on", () => {
		const reason = skillDraftReason({
			skill: draft,
			runs: [run("completed")],
			schedules: [{ enabled: true }, { enabled: false }],
			canTurnOn: true,
		})!;
		expect(reason.schedulePaused).toBe(true);
		expect(reason.why.at(-1)).toBe(
			"Its schedule is paused, so no scheduled runs start.",
		);
		expect(reason.next.at(-1)).toMatch(/^Open the Settings tab/);
	});

	it("sends a proposed change to the skill it would change", () => {
		const reason = skillDraftReason({
			skill: { ...draft, tags: ["workflow-improvement"] },
			runs: [run("failed"), run("failed"), run("failed")],
			schedules: [{ enabled: false }],
			canTurnOn: true,
		})!;
		expect(reason.kind).toBe("proposal");
		expect(reason.next).toEqual([
			"Review it on the Versions tab of the skill it would change, and adopt it there if it is better.",
		]);
	});

	it("claims no cause while the runs are not loaded", () => {
		const reason = skillDraftReason({
			skill: draft,
			runs: undefined,
			canTurnOn: true,
		})!;
		expect(reason.kind).toBe("unknown");
		expect(reason.why).toEqual(["A draft does not run on a schedule."]);
		expect(reason.testFirst).toBe(false);
	});

	it("tells someone who cannot turn it on whom to ask, and skips the test for instructions-only skills", () => {
		expect(
			skillDraftReason({ skill: draft, runs: [], canTurnOn: false })!.next,
		).toEqual(["Ask an owner or admin to turn this skill back on."]);
		const instructions = skillDraftReason({
			skill: { ...draft, files: null },
			runs: [],
			canTurnOn: true,
		})!;
		expect(instructions.testFirst).toBe(false);
		expect(instructions.next).toEqual([
			"Turn it back on when its instructions are ready.",
		]);
	});
});

describe("run error and trend helpers", () => {
	it("keeps one readable line of an error", () => {
		expect(plainRunError("TypeError: x is not a function\n  at y")).toBe(
			"x is not a function",
		);
		expect(plainRunError("  \n")).toBeNull();
		expect(plainRunError("a".repeat(400))).toHaveLength(300);
	});

	it("summarizes the newest finished runs only", () => {
		expect(recentRunTrend(undefined)).toBeNull();
		expect(recentRunTrend([{ status: "running" }])).toBeNull();
		expect(
			recentRunTrend([
				{ status: "running" },
				{ status: "failed" },
				{ status: "failed" },
				{ status: "canceled" },
				{ status: "completed" },
				{ status: "failed" },
				{ status: "completed" },
			]),
		).toEqual({ finished: 5, completed: 1, failed: 3 });
	});
});
