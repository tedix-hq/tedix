import type {
	LearningFeedbackAttribution,
	LearningFeedbackMeasurement,
	LearningInteractionEvent,
} from "@tedix/api-contract/schemas/learning-feedback";
import { describe, expect, it } from "vite-plus/test";
import type { DbClient } from "../client";
import {
	recordLearningInteraction,
	summarizeLearningFeedback,
	summarizeRecurringLearningIssues,
	validateLearningMeasurementPair,
} from "./learning-feedback";

function makeDb(script: {
	insert?: unknown[][];
	select?: unknown[][];
}): DbClient {
	const queues = {
		insert: [...(script.insert ?? [])],
		select: [...(script.select ?? [])],
	};
	const node = (kind: "insert" | "select"): unknown =>
		new Proxy(() => {}, {
			get(_target, prop) {
				if (prop === "then") {
					const settled = Promise.resolve(queues[kind].shift() ?? []);
					return settled.then.bind(settled);
				}
				return () => node(kind);
			},
			apply() {
				return node(kind);
			},
		});
	return {
		insert: () => node("insert"),
		select: () => node("select"),
	} as unknown as DbClient;
}

const attribution = (
	over: Partial<LearningFeedbackAttribution> = {},
): LearningFeedbackAttribution & {
	eventKind: "rejected" | "edited";
	issueKey: string | null;
} => ({
	id: "attr-1",
	organizationId: "org-1",
	clientAttributionId: "client-attr-1",
	feedbackEventId: "event-1",
	subjectKind: "harness_version",
	subjectId: "hv-2",
	changeKind: "promoted",
	rationale: "Reduce repeated CSV export failures",
	evidenceRefs: ["trace://run-1"],
	metadata: null,
	occurredAt: "2026-07-08T00:00:00.000Z",
	createdAt: "2026-07-08T00:00:00.000Z",
	eventKind: "rejected",
	issueKey: "csv-export-format",
	...over,
});

describe("summarizeRecurringLearningIssues", () => {
	const event = (
		id: string,
		eventKind: LearningInteractionEvent["eventKind"],
		over: Partial<LearningInteractionEvent> = {},
	): LearningInteractionEvent => ({
		id,
		organizationId: "org-1",
		actorType: "user",
		actorId: `user-${id}`,
		tediId: "tedi-1",
		clientEventId: `client-${id}`,
		signalClass: "quality",
		eventKind,
		scopeKind: "tedi",
		scopeId: "tedi-1",
		issueKey: "csv-export",
		surface: "os",
		targetType: null,
		targetId: null,
		threadId: null,
		runId: `run-${id}`,
		metadata: null,
		occurredAt: `2026-07-1${id}T00:00:00.000Z`,
		createdAt: `2026-07-1${id}T00:00:01.000Z`,
		...over,
	});

	it("only marks a grouped issue eligible after three negative occurrences", () => {
		const [issue] = summarizeRecurringLearningIssues({
			events: [
				event("1", "rejected"),
				event("2", "retried"),
				event("3", "edited"),
				event("4", "accepted"),
			],
			minimumOccurrences: 3,
			limit: 10,
		});
		expect(issue).toMatchObject({
			issueKey: "csv-export",
			occurrenceCount: 4,
			negativeCount: 3,
			acceptedCount: 1,
			eligible: true,
		});
		expect(issue?.evidenceEventIds).toEqual(["1", "2", "3"]);
	});

	it("keeps different scopes and issues separated", () => {
		const issues = summarizeRecurringLearningIssues({
			events: [
				event("1", "rejected"),
				event("2", "rejected", { scopeId: "tedi-2" }),
			],
			minimumOccurrences: 3,
			limit: 10,
		});
		expect(issues).toHaveLength(2);
		expect(issues.every((issue) => !issue.eligible)).toBe(true);
	});

	it("does not treat governance or lifecycle decisions as quality failures", () => {
		const [issue] = summarizeRecurringLearningIssues({
			events: [
				event("1", "rejected", { signalClass: "governance" }),
				event("2", "rejected", { signalClass: "governance" }),
				event("3", "ignored", { signalClass: "lifecycle" }),
			],
			minimumOccurrences: 3,
			limit: 10,
		});
		expect(issue).toMatchObject({ negativeCount: 0, eligible: false });
		expect(issue?.evidenceEventIds).toEqual([]);
	});
});

const measurement = (
	over: Partial<LearningFeedbackMeasurement>,
): LearningFeedbackMeasurement => ({
	id: "measure-1",
	organizationId: "org-1",
	clientMeasurementId: "client-measure-1",
	attributionId: "attr-1",
	windowKind: "baseline",
	windowStart: "2026-07-01T00:00:00.000Z",
	windowEnd: "2026-07-07T00:00:00.000Z",
	opportunityCount: 20,
	recurrenceCount: 8,
	successCount: 12,
	metadata: null,
	createdAt: "2026-07-08T00:00:00.000Z",
	...over,
});

describe("summarizeLearningFeedback", () => {
	it("proves improvement from a lower follow-up recurrence rate", () => {
		const summary = summarizeLearningFeedback({
			subjectKind: "harness_version",
			subjectId: "hv-2",
			issueKey: "csv-export-format",
			attributions: [
				attribution(),
				attribution({
					id: "attr-2",
					feedbackEventId: "event-2",
					eventKind: "edited",
				}),
			],
			measurements: [
				measurement({}),
				measurement({
					id: "measure-2",
					clientMeasurementId: "client-measure-2",
					windowKind: "followup",
					windowStart: "2026-07-09T00:00:00.000Z",
					windowEnd: "2026-07-15T00:00:00.000Z",
					recurrenceCount: 2,
					successCount: 18,
				}),
			],
		});

		expect(summary.attributionCount).toBe(2);
		expect(summary.attributedEventCount).toBe(2);
		expect(summary.eventKinds).toEqual({ rejected: 1, edited: 1 });
		expect(summary.baseline?.recurrenceRate).toBe(0.4);
		expect(summary.followup?.recurrenceRate).toBe(0.1);
		expect(summary.recurrenceRateDelta).toBeCloseTo(-0.3);
		expect(summary.improved).toBe(true);
	});

	it("does not claim improvement without both measurement windows", () => {
		const summary = summarizeLearningFeedback({
			subjectKind: "skill",
			subjectId: "skill-1",
			attributions: [],
			measurements: [],
		});
		expect(summary.improved).toBeNull();
		expect(summary.recurrenceRateDelta).toBeNull();
	});
});

describe("validateLearningMeasurementPair", () => {
	it("accepts only a chronological pair from one attributed cohort", () => {
		const baseline = measurement({ id: "baseline-1" });
		const followup = measurement({
			id: "followup-1",
			clientMeasurementId: "followup-client",
			windowKind: "followup",
			windowStart: "2026-07-08T00:00:00.000Z",
			windowEnd: "2026-07-15T00:00:00.000Z",
			recurrenceCount: 2,
		});
		expect(
			validateLearningMeasurementPair({
				baseline,
				followup,
				allowedAttributionIds: new Set(["attr-1"]),
			}),
		).toEqual({ valid: true, improved: true, reason: null });
		expect(
			validateLearningMeasurementPair({
				baseline,
				followup: { ...followup, attributionId: "attr-other" },
				allowedAttributionIds: new Set(["attr-1", "attr-other"]),
			}).valid,
		).toBe(false);
		expect(
			validateLearningMeasurementPair({
				baseline,
				followup: {
					...followup,
					windowStart: "2026-07-06T00:00:00.000Z",
				},
				allowedAttributionIds: new Set(["attr-1"]),
			}).valid,
		).toBe(false);
	});
});

describe("recordLearningInteraction", () => {
	const input = {
		organizationId: "org-1",
		actorType: "user" as const,
		actorId: "user-1",
		tediId: "tedi-1",
		clientEventId: "event-key-1",
		eventKind: "rejected" as const,
		scopeKind: "tedi" as const,
		scopeId: "tedi-1",
		issueKey: "csv-export",
		surface: "os",
		occurredAt: "2026-07-16T12:00:00.000Z",
	};

	it("returns an existing semantically identical event as a duplicate", async () => {
		const db = makeDb({
			insert: [[]],
			select: [
				[
					{
						...input,
						id: "event-1",
						targetType: null,
						targetId: null,
						threadId: null,
						runId: null,
						metadata: null,
						createdAt: "2026-07-16T12:00:01.000Z",
						signalClass: "quality",
					},
				],
			],
		});
		const result = await recordLearningInteraction(db, input);
		expect(result.duplicate).toBe(true);
		expect(result.event.id).toBe("event-1");
	});

	it("rejects reuse of an idempotency key for a different interaction", async () => {
		const db = makeDb({
			insert: [[]],
			select: [
				[
					{
						...input,
						id: "event-1",
						eventKind: "accepted",
						targetType: null,
						targetId: null,
						threadId: null,
						runId: null,
						metadata: null,
						createdAt: "2026-07-16T12:00:01.000Z",
						signalClass: "quality",
					},
				],
			],
		});
		await expect(recordLearningInteraction(db, input)).rejects.toThrow(
			/different interaction/,
		);
	});
});
