import { describe, expect, it } from "vite-plus/test";
import {
	DecisionDeckConfigSchema,
	decisionNeedsPerson,
} from "@tedix/api-contract/schemas/os-decision-deck";
import { OsGadgetManifestWriteSchema } from "@tedix/api-contract/schemas/os-workspaces";
import { DECISION_DECK_EXAMPLES } from "../../dev/decision-deck-fixture";
import {
	decisionLearningKey,
	decisionIsDue,
	decisionDeadlinePassed,
	workIsUnowned,
	compareDecisionFreshness,
	classReadiness,
	decisionEnvelope,
	decisionFeedbackMetadata,
	type DecisionLearningReceipt,
} from "./decision-deck";

describe("decision deck policy projection", () => {
	it("keeps protected effects and uncertainty in review, while reversible implementation leaves the deck", () => {
		const adr = DECISION_DECK_EXAMPLES[5]!;
		for (const kind of ["outbound", "approval"] as const)
			expect(
				decisionNeedsPerson({
					...adr,
					kind,
					protectedEffects: [],
					reversibility: "two_way",
				}),
			).toBe(true);
		expect(decisionNeedsPerson({ ...adr, reversibility: "two_way" })).toBe(
			true,
		);
		expect(
			decisionNeedsPerson({
				...adr,
				protectedEffects: [],
				reversibility: "unknown",
			}),
		).toBe(true);
		expect(
			decisionNeedsPerson({
				...adr,
				protectedEffects: [],
				reversibility: "two_way",
			}),
		).toBe(false);
		expect(
			decisionNeedsPerson({
				...adr,
				protectedEffects: [],
				reversibility: "two_way",
				tasteOrStrategy: true,
			}),
		).toBe(true);
	});
	it("uses distinct evidence, resets on a rejection and never treats delegation or edits as unchanged approval", () => {
		const receipt = (
			id: string,
			signal = "approve-as-is",
			choice = "approve",
		): DecisionLearningReceipt => ({
			id,
			classId: "architecture",
			signal,
			choice,
			at: `2026-10-17T10:0${id}:00Z`,
		});
		const receipts = [receipt("1"), receipt("2"), receipt("2")];
		expect(classReadiness(receipts, "architecture", 2)).toMatchObject({
			unchanged: 2,
			ready: true,
		});
		for (const row of [
			receipt("3", "rejected", "reject"),
			receipt("3", "edited", "change"),
			receipt("3", "answer", "delegate"),
		])
			expect(
				classReadiness([...receipts, row], "architecture", 2),
			).toMatchObject({ unchanged: 0, ready: false });
		expect(classReadiness(receipts, "marketing", 2).unchanged).toBe(0);
	});
	it("preserves edits and elapsed time without learning approval from Later or Decide for me", () => {
		const feedback = {
			action: "delegate",
			body: "Short",
			originalBody: "A longer draft",
			signal: "approve-as-is" as const,
		};
		expect(
			decisionFeedbackMetadata(feedback, "acme-style", "delegate", 12.7),
		).toMatchObject({
			feedbackSignal: "answer",
			elapsedMs: 13,
			originalBody: "A longer draft",
			editedBody: "Short",
		});
		expect(
			decisionFeedbackMetadata(feedback, "acme-style", "change", 0).editRatio,
		).toBeGreaterThan(0);
	});
	it("validates a tenant-neutral manifest with all six kinds and bounded organization settings", () => {
		const config = DecisionDeckConfigSchema.parse({
			version: 1,
			examples: DECISION_DECK_EXAMPLES,
		});
		expect(
			OsGadgetManifestWriteSchema.parse({
				entry: "tedix:app/decision-deck",
				config,
			}).config,
		).toEqual(config);
		for (const dailyAttentionBudget of [0, 101])
			expect(
				OsGadgetManifestWriteSchema.safeParse({
					entry: "tedix:app/decision-deck",
					config: { ...config, dailyAttentionBudget },
				}).success,
			).toBe(false);
		expect(decisionEnvelope({ decisionDeck: { kind: "adr" } })).toBeNull();
	});
});

it("distinguishes nobody carrying an outcome from a live Attempt or an unknown read", () => {
	expect(workIsUnowned(undefined)).toBe(false);
	expect(workIsUnowned({ accountableOwnerId: null })).toBe(false);
	expect(
		workIsUnowned({
			accountableOwnerId: null,
			activeAttempt: { executorId: "fictional-worker" },
		}),
	).toBe(false);
	expect(
		workIsUnowned({
			accountableOwnerId: "fictional-owner",
			activeAttempt: null,
		}),
	).toBe(false);
	expect(workIsUnowned({ accountableOwnerId: null, activeAttempt: null })).toBe(
		true,
	);
});

it("demotes elapsed deadlines even when learning would boost the old ask", () => {
	const now = new Date("2026-10-18T00:30:00Z");
	const stale = { dueAt: "2026-10-13T09:00:00Z", score: 1000 };
	const fresh = { requestedAt: "2026-10-17T22:00:00Z", score: 5 };
	expect(compareDecisionFreshness(stale, fresh, now)).toBeGreaterThan(0);
	expect(compareDecisionFreshness(fresh, stale, now)).toBeLessThan(0);
});
it("uses deadline then recency without learning and preserves learned ranking for fresh cards", () => {
	const now = new Date("2026-10-18T00:30:00Z");
	const due = {
		dueAt: "2026-10-18T06:30:00Z",
		requestedAt: "2026-10-17T20:00:00Z",
	};
	const recent = { requestedAt: "2026-10-17T23:00:00Z" };
	expect(compareDecisionFreshness(due, recent, now)).toBeLessThan(0);
	expect(
		compareDecisionFreshness(
			recent,
			{ requestedAt: "2026-10-12T20:00:00Z" },
			now,
		),
	).toBeLessThan(0);
	expect(
		compareDecisionFreshness(
			{ ...recent, score: 20 },
			{ ...due, score: 5 },
			now,
		),
	).toBeLessThan(0);
});

it("correlates only canonical effect receipts, including Outbound's pre-send revision", () => {
	expect(decisionLearningKey({ response: { id: "saved-answer" } })).toBe(
		"decision-capture:saved-answer",
	);
	expect(
		decisionLearningKey({
			version: 4,
			learningClientEventId: "outbound:copied-work:3",
		}),
	).toBe("outbound:copied-work:3");
	expect(
		decisionLearningKey({ event: { id: "secondary-telemetry" } }),
	).toBeUndefined();
	expect(decisionLearningKey(undefined)).toBeUndefined();
});

it("holds every future decision until its scheduled calendar date", () => {
	const request = { kind: "coordination", dueAt: "2026-10-28T08:00:00Z" };
	expect(decisionIsDue(request, new Date("2026-10-18T10:09:00Z"))).toBe(false);
	expect(decisionIsDue(request, new Date(request.dueAt))).toBe(true);
	expect(decisionIsDue(request, new Date("2026-10-29T10:09:00Z"))).toBe(true);
	expect(
		decisionIsDue(
			{ ...request, kind: "question" },
			new Date("2026-10-18T10:09:00Z"),
		),
	).toBe(false);
	expect(decisionIsDue({ kind: "coordination" }, new Date())).toBe(true);
});

it("keeps due follow-ups actionable while elapsed question deadlines require revalidation", () => {
	const dueAt = "2026-10-28T08:00:00Z";
	const now = new Date("2026-10-29T08:00:00Z");
	expect(decisionDeadlinePassed({ kind: "coordination", dueAt }, now)).toBe(
		false,
	);
	expect(decisionDeadlinePassed({ kind: "question", dueAt }, now)).toBe(true);
	expect(
		decisionDeadlinePassed({ kind: "question", dueAt }, new Date(dueAt)),
	).toBe(false);
	expect(decisionDeadlinePassed({ kind: "question" }, now)).toBe(false);
});

it("keeps fresh approvals ahead of newer filing questions without reviving stale approvals", async () => {
	const { compareDecisionFreshness } = await import("./decision-deck");
	const now = new Date("2026-10-18T12:00:00Z");
	const approval = { kind: "approval", requestedAt: "2026-10-17T10:00:00Z" };
	const question = { kind: "question", requestedAt: "2026-10-18T11:59:00Z" };
	expect(compareDecisionFreshness(approval, question, now)).toBeLessThan(0);
	expect(
		compareDecisionFreshness(
			{ ...approval, dueAt: "2026-10-18T10:00:00Z" },
			question,
			now,
		),
	).toBeGreaterThan(0);
});
