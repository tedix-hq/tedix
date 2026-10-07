import { describe, expect, it } from "vite-plus/test";
import {
	AnalyzeRecurringLearningIssuesInputSchema,
	LearningScopeInputSchema,
	ProposeLearningImprovementInputSchema,
	RecordLearningInteractionInputSchema,
	RecordLearningMeasurementInputSchema,
} from "./learning-feedback";

describe("learning feedback schemas", () => {
	it("accepts every supported product interaction with a tedi scope", () => {
		for (const eventKind of [
			"accepted",
			"edited",
			"ignored",
			"rejected",
			"retried",
			"undone",
			"manually_replaced",
			"completed_elsewhere",
			"answered",
		] as const) {
			expect(
				RecordLearningInteractionInputSchema.parse({
					clientEventId: `event-${eventKind}`,
					eventKind,
					scope: { kind: "tedi" },
					surface: "os",
				}),
			).toMatchObject({ eventKind, scope: { kind: "tedi" } });
		}
	});

	it("requires explicit ids only for project and workflow scopes", () => {
		expect(() => LearningScopeInputSchema.parse({ kind: "project" })).toThrow();
		expect(() =>
			LearningScopeInputSchema.parse({ kind: "workflow", id: "wf-1" }),
		).not.toThrow();
		expect(() =>
			LearningScopeInputSchema.parse({ kind: "personal", id: "spoofed" }),
		).toThrow();
		expect(() =>
			LearningScopeInputSchema.parse({ kind: "organization", id: "spoofed" }),
		).toThrow();
	});

	it("rejects impossible recurrence measurements", () => {
		const base = {
			clientMeasurementId: "measure-1",
			attributionId: "attr-1",
			windowKind: "followup" as const,
			windowStart: "2026-07-01T00:00:00.000Z",
			windowEnd: "2026-07-08T00:00:00.000Z",
			opportunityCount: 10,
			recurrenceCount: 2,
			successCount: 8,
		};
		expect(() =>
			RecordLearningMeasurementInputSchema.parse(base),
		).not.toThrow();
		expect(() =>
			RecordLearningMeasurementInputSchema.parse({
				...base,
				recurrenceCount: 11,
			}),
		).toThrow();
		expect(() =>
			RecordLearningMeasurementInputSchema.parse({
				...base,
				windowEnd: base.windowStart,
			}),
		).toThrow();
	});

	it("requires three distinct interaction slots before proposing improvement", () => {
		const base = {
			clientProposalId: "proposal-1",
			subjectKind: "workflow" as const,
			subjectId: "workflow-1",
			recommendation: "Add a bounded retry around the failing export step.",
		};
		expect(() =>
			ProposeLearningImprovementInputSchema.parse({
				...base,
				evidenceEventIds: ["event-1", "event-2", "event-3"],
			}),
		).not.toThrow();
		expect(() =>
			ProposeLearningImprovementInputSchema.parse({
				...base,
				evidenceEventIds: ["event-1", "event-2"],
			}),
		).toThrow();
		expect(AnalyzeRecurringLearningIssuesInputSchema.parse({})).toMatchObject({
			minimumOccurrences: 3,
			limit: 25,
		});
	});
});
