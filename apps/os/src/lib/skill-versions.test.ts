import type {
	SkillEntry,
	SkillWorkflowRevision,
} from "@tedix/api-contract/schemas/cognitive";
import { describe, expect, it } from "vite-plus/test";
import {
	plainChangeMessage,
	skillVersionRows,
	skillVersionRunLine,
	splitChangeNotes,
} from "./skill-versions";

const ID = "11111111-2222-4333-8444-555555555555";
const observed = (
	revision: number | null,
	patch: Partial<SkillWorkflowRevision> = {},
) =>
	({
		runId: `run-${revision}`,
		revision,
		observedRunCount: 2,
		completedCount: 2,
		failedCount: 0,
		canceledCount: 0,
		firstObservedAt: "2026-10-01T10:00:00Z",
		lastObservedAt: "2026-10-02T10:00:00Z",
		runtimeVariants: [],
		...patch,
	}) as SkillWorkflowRevision;
const draft = (patch: Partial<SkillEntry>) =>
	({ id: "draft", title: "Draft", ...patch }) as SkillEntry;

describe("plainChangeMessage", () => {
	it("keeps the reason a person gave and drops the wrapping and ids", () => {
		expect(
			plainChangeMessage(
				`Workflow improvement ${ID} activated by user U2abc after certified run ${ID}: Skip duplicate requests`,
			),
		).toBe("Skip duplicate requests");
		expect(
			plainChangeMessage(
				`Workflow improvement proposed from run ${ID} at baseline revision 4. Score v2`,
			),
		).toBe("Score v2");
		expect(
			plainChangeMessage(
				`Switched on from the Tedix OS versions page after test run ${ID}`,
			),
		).toBe("Adopted after a passed test");
		expect(
			plainChangeMessage(`Roll back to revision 3 (files pinned by run ${ID})`),
		).toBe("Restored revision 3");
		expect(plainChangeMessage(`Tidied wording (draft ${ID}).`)).toBe(
			"Tidied wording.",
		);
	});
	it("leaves ordinary text alone and returns null for nothing", () => {
		expect(plainChangeMessage("Clearer instructions (second pass)")).toBe(
			"Clearer instructions (second pass)",
		);
		expect(plainChangeMessage("  ")).toBeNull();
		expect(plainChangeMessage(ID)).toBeNull();
		expect(plainChangeMessage(null)).toBeNull();
	});
});

describe("splitChangeNotes", () => {
	it("separates what people wrote from automatic cleanup", () => {
		const cleanup = `Removed 1 workflow improvement copy (${ID}): abandoned`;
		expect(
			splitChangeNotes(
				`Clearer instructions\n${cleanup}\n\nRemoved 3 workflow improvement copies: swept\nBaseline abc; candidate def.\nShorter summary`,
			),
		).toEqual({
			messages: ["Clearer instructions", "Shorter summary"],
			housekeeping: [
				cleanup,
				"Removed 3 workflow improvement copies: swept",
				"Baseline abc; candidate def.",
			],
		});
		expect(splitChangeNotes(null)).toEqual({ messages: [], housekeeping: [] });
	});
});

describe("skillVersionRows", () => {
	it("puts the current version first, then newest to oldest", () => {
		const rows = skillVersionRows({
			current: { revision: 2, revisionReasoning: "Second try" },
			revisions: [observed(1), observed(3), observed(2)],
			drafts: [],
		});
		expect(rows.map((row) => row.revision)).toEqual([2, 3, 1]);
		expect(rows.map((row) => row.current)).toEqual([true, false, false]);
		expect(rows[0]!.message).toBe("Second try");
		expect(rows[1]!.message).toBeNull();
	});
	it("lists the current version before it has run, and adopted versions that never ran", () => {
		const rows = skillVersionRows({
			current: {
				revision: 5,
				revisionReasoning: `First\nRemoved 1 workflow improvement copy (${ID}): x`,
				updatedAt: "2026-11-01T08:00:00Z",
			},
			revisions: [observed(3)],
			drafts: [
				draft({
					improvementAdoption: {
						activatedIntoRevision: 4,
						certificationRunId: "passed",
						adoptedAt: "2026-10-20T09:00:00Z",
						reason: "Faster lookup",
					},
				}),
				draft({ id: "waiting" }),
			],
		});
		expect(rows.map((row) => row.revision)).toEqual([5, 4, 3]);
		expect(rows[0]).toMatchObject({
			current: true,
			message: "First",
			observed: null,
			changedLabel: "Updated",
			changedAt: "2026-11-01T08:00:00Z",
			previousRunId: null,
		});
		expect(rows[1]).toMatchObject({
			message: "Faster lookup",
			changedLabel: "Adopted",
			changedAt: "2026-10-20T09:00:00Z",
			testRunId: "passed",
			observed: null,
		});
		expect(rows[2]).toMatchObject({
			changedLabel: "First ran",
			testRunId: null,
		});
	});
	it("prefers the reason the draft was proposed with over the adoption note", () => {
		const [row] = skillVersionRows({
			current: null,
			revisions: [],
			drafts: [
				draft({
					revisionReasoning: `Workflow improvement proposed from run ${ID} at baseline revision 1. Skip duplicates\nBaseline a; candidate b.`,
					improvementAdoption: {
						activatedIntoRevision: 2,
						certificationRunId: null,
						adoptedAt: null,
						reason: `Switched on from the Tedix OS versions page after test run ${ID}`,
					},
				}),
			],
		});
		expect(row).toMatchObject({
			revision: 2,
			current: false,
			message: "Skip duplicates",
			changedAt: null,
			changedLabel: null,
		});
	});
	it("compares a version with the next older one that ran", () => {
		const rows = skillVersionRows({
			current: { revision: 4 },
			revisions: [observed(4), observed(2), observed(1)],
			drafts: [],
		});
		expect(
			rows.map((row) => [
				row.revision,
				row.previousRevision,
				row.previousRunId,
			]),
		).toEqual([
			[4, 2, "run-2"],
			[2, 1, "run-1"],
			[1, null, null],
		]);
	});
	it("marks nothing current while the skill's details are unknown and keeps unnumbered runs last", () => {
		const rows = skillVersionRows({
			current: null,
			revisions: [observed(null), observed(1)],
			drafts: [],
		});
		expect(rows.map((row) => [row.revision, row.current])).toEqual([
			[1, false],
			[null, false],
		]);
	});
});

describe("skillVersionRunLine", () => {
	it("says how many runs and how many completed", () => {
		expect(skillVersionRunLine(observed(1))).toBe("2 runs · 100% completed");
		expect(
			skillVersionRunLine(
				observed(1, {
					observedRunCount: 12,
					completedCount: 8,
					failedCount: 3,
					canceledCount: 1,
				}),
			),
		).toBe("12 runs · 67% completed · 3 failed");
		expect(
			skillVersionRunLine(
				observed(1, { observedRunCount: 1, completedCount: 0 }),
			),
		).toBe("1 run · none finished yet");
		expect(skillVersionRunLine(null)).toBe("No runs yet");
	});
});
