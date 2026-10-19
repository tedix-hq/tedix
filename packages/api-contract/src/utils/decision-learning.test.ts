import { describe, expect, it } from "vite-plus/test";
import { DecisionLearningConfigSchema } from "../schemas/decision-learning";
import type { LearningInteractionEvent } from "../schemas/learning-feedback";
import {
	learnDecisions,
	scoreLearning,
	draftLearningContext,
	learningAutoReadiness,
} from "./decision-learning";

const now = new Date("2026-06-10T10:00:00Z");
const config = DecisionLearningConfigSchema.parse({
	enabled: true,
	auditSampleRate: 0,
});
function event(
	i: number,
	patch: Partial<LearningInteractionEvent> = {},
): LearningInteractionEvent {
	return {
		id: `signal-${i}`,
		organizationId: "fictional-lighthouse",
		actorType: "user",
		actorId: "person-river",
		tediId: null,
		clientEventId: `client-${i}`,
		signalClass: "quality",
		eventKind: "accepted",
		scopeKind: "personal",
		scopeId: "person-river",
		issueKey: null,
		surface: "decision_capture",
		targetType: "work_interaction",
		targetId: `card-${i}`,
		threadId: null,
		runId: null,
		metadata: {
			decisionClass: "investor-email",
			decisionChoice: "approve",
			feedbackSignal: "approve-as-is",
			serverObserved: true,
			projectId: "project-seed",
			elapsedMs: 1500,
		},
		occurredAt: new Date(now.getTime() - 60000 * (35 - i)).toISOString(),
		createdAt: now.toISOString(),
		...patch,
	};
}
const learn = (events: LearningInteractionEvent[], overrides = {}) =>
	learnDecisions({
		organizationId: "fictional-lighthouse",
		personId: "person-river",
		config,
		events,
		now,
		...overrides,
	});

describe("decision learning replay", () => {
	it("does not train preferences from machine routing receipts", () => {
		const model = learn([
			event(1, { surface: "decision_deck_routing", eventKind: "delivered" }),
		]);
		expect(model.eventCount).toBe(0);
		expect(model.weights.usefulness).toEqual([]);
	});
	it("correlates the completed decision receipt when another card has the same class", () => {
		const completed = event(1, { clientEventId: "decision-capture:reply-one" });
		const newer = event(2, { clientEventId: "decision-capture:reply-two" });
		const otherPerson = event(3, {
			clientEventId: "decision-capture:private-reply",
			actorId: "person-sky",
			scopeId: "person-sky",
		});
		const model = learn([completed, newer, otherPerson]);
		expect(model.receipts[0]?.eventId).toBe(newer.id);
		expect(
			model.receipts.find(
				(receipt) => receipt.clientEventId === completed.clientEventId,
			)?.eventId,
		).toBe(completed.id);
		expect(
			model.receipts.some(
				(receipt) => receipt.clientEventId === otherPerson.clientEventId,
			),
		).toBe(false);
		expect(model.eventCount).toBe(2);
	});

	it("30 decisions change both ordering and the writing context used to regenerate a draft", () => {
		const events = Array.from({ length: 30 }, (_, i) =>
			i < 10
				? event(i, {
						eventKind: "rejected",
						metadata: {
							decisionClass: "generic-news",
							projectId: "project-noise",
							reaction: "mute",
						},
					})
				: i < 20
					? event(i, {
							eventKind: "edited",
							metadata: {
								decisionClass: "investor-email",
								projectId: "project-seed",
								originalBody:
									"I am writing to you today because I would really like to introduce our project and discuss a potential investment with your team.",
								editedBody: "Could we discuss our seed round?",
							},
						})
					: event(i),
		);
		const before = learn([]);
		const after = learn(events);
		const candidates = [
			{ id: "news", classId: "generic-news", projectId: "project-noise" },
			{ id: "investor", classId: "investor-email", projectId: "project-seed" },
		];
		const rank = (model: ReturnType<typeof learn>) =>
			[...candidates]
				.sort(
					(a, b) =>
						scoreLearning(b, model, now).score -
						scoreLearning(a, model, now).score,
				)
				.map((c) => c.id);
		expect(rank(before)).toEqual(["news", "investor"]);
		expect(rank(after)).toEqual(["investor", "news"]);
		expect(after.eventCount).toBe(30);
		expect(after.preferences[0]?.maxCharacters).toBe(32);
		expect(draftLearningContext(after)).toContain("shorter wording");
		expect(draftLearningContext(before)).not.toContain("shorter wording");
		expect(
			scoreLearning(candidates[1]!, after, now).factors.some(
				(f) => f.evidenceIds.length,
			),
		).toBe(true);
	});
	it("correction removes the original contribution, edit preference, and class promotion", () => {
		const approvals = Array.from({ length: 5 }, (_, i) => event(i));
		const ready = learn(approvals);
		expect(
			learningAutoReadiness({ id: "safe", classId: "investor-email" }, ready)
				.ready,
		).toBe(true);
		const correction = event(6, {
			eventKind: "undone",
			metadata: { learningCorrection: true, correctsEventId: "signal-4" },
		});
		expect(learn([...approvals, correction]).readiness[0]?.ready).toBe(false);
		expect(
			learn([...approvals, event(7, { eventKind: "rejected" })]).readiness[0]
				?.ready,
		).toBe(false);
		expect(
			learningAutoReadiness(
				{ id: "email", classId: "investor-email", protected: true },
				ready,
			).ready,
		).toBe(false);
	});
	it("isolates tenants and personal context, deduplicates, and rejects another person's correction", () => {
		const e = event(1);
		expect(
			learn([
				e,
				e,
				event(2, { organizationId: "other-org" }),
				event(3, { scopeId: "other-person" }),
			]).eventCount,
		).toBe(1);
		expect(
			learn([
				e,
				event(4, {
					actorId: "other-person",
					metadata: { learningCorrection: true, correctsEventId: e.id },
					eventKind: "undone",
				}),
			]).eventCount,
		).toBe(1);
	});
	it("time passing raises deadlines, quiet hours soften only optional items, and audit selection is stable", () => {
		const model = learn([]);
		const c = {
			id: "deadline",
			classId: "work",
			dueAt: "2026-06-11T10:00:00Z",
		};
		expect(
			scoreLearning(c, model, new Date("2026-06-11T09:00:00Z")).score,
		).toBeGreaterThan(scoreLearning(c, model, now).score);
		expect(
			scoreLearning(c, model, new Date("2026-06-12T10:00:00Z")).factors,
		).toContainEqual(
			expect.objectContaining({
				reason: "Overdue since 2026-06-11T10:00:00Z; waiting has a cost",
			}),
		);
		const audited = learn(
			Array.from({ length: 5 }, (_, i) => event(i)),
			{ config: { ...config, auditSampleRate: 1 } },
		);
		expect(learningAutoReadiness(c, audited)).toEqual(
			learningAutoReadiness(c, audited),
		);
		expect(learningAutoReadiness(c, audited).ready).toBe(false);
	});
});

it("uses shared lessons, source usefulness, urgency feedback and class-specific time patterns", () => {
	const model = learn(
		[
			event(1, {
				eventKind: "rejected",
				tediId: "tedi-pine",
				metadata: {
					decisionClass: "news",
					source: "/work/items/old",
					urgency: "now",
				},
			}),
			event(2, {
				scopeKind: "organization",
				scopeId: "fictional-lighthouse",
				metadata: {
					decisionClass: "investor-email",
					projectId: "project-seed",
				},
			}),
		],
		{
			lessons: [
				{
					id: "lesson-intros",
					text: "Keep investor introductions brief.",
					classId: null,
					triggers: { keywords: ["investor"] },
				},
			],
		},
	);
	const news = scoreLearning(
		{
			id: "new",
			classId: "news",
			source: "/work/items/new",
			tediId: "tedi-pine",
			urgency: 1,
		},
		model,
		now,
	);
	expect(
		news.factors.some(
			(f) => f.level === "urgency" && f.evidenceIds.includes("signal-1"),
		),
	).toBe(true);
	expect(news.factors.filter((f) => f.level === "usefulness").length).toBe(3);
	const investor = scoreLearning(
		{ id: "investor", classId: "investor-email", projectId: "project-seed" },
		model,
		now,
	);
	expect(investor.lessonIds).toContain("lesson-intros");
	expect(investor.factors.some((f) => f.level === "organization")).toBe(true);
});
it("a correction removes a writing preference and prevents derived classification from reviving it", () => {
	const edit = (i: number) =>
		event(i, {
			eventKind: "edited",
			metadata: {
				decisionClass: "investor-email",
				originalBody:
					"An unnecessarily long introduction with several extra words.",
				editedBody: "Our seed round is open.",
			},
		});
	const edits = [edit(1), edit(2)];
	expect(learn(edits).preferences).toHaveLength(1);
	const enriched = event(3, {
		eventKind: "edited",
		metadata: {
			decisionClass: "investor-email",
			preferenceSource: "classifier",
			preferenceEvidenceEventId: "signal-2",
			preferenceSentence: "Prefer brief introductions.",
		},
	});
	const correction = event(4, {
		eventKind: "undone",
		metadata: { learningCorrection: true, correctsEventId: "signal-2" },
	});
	expect(learn([...edits, enriched, correction]).preferences).toHaveLength(0);
});

it("measures only personal rail observations and feeds weak summaries to generation", () => {
	const observed = (i: number, railOpenedBeforeDecision: boolean) =>
		event(i, {
			surface: "decision_deck_action",
			metadata: {
				decisionClass: "supplier-review",
				decisionChoice: "approve",
				railOpenedBeforeDecision,
			},
		});
	const model = learn([
		observed(1, false),
		observed(2, true),
		observed(3, true),
		event(4),
		observed(5, false),
		{ ...observed(6, false), actorId: "other-person", scopeId: "other-person" },
		{
			...observed(7, false),
			metadata: {
				decisionClass: "supplier-review",
				decisionChoice: "later",
				railOpenedBeforeDecision: false,
			},
		},
	]);
	expect(model.cardIntuitiveness).toMatchObject({
		decisions: 4,
		fromCard: 2,
		percent: 50,
		classes: [{ classId: "supplier-review", needsBetterSummary: true }],
	});
	expect(
		JSON.parse(draftLearningContext(model)).summaryImprovements[0],
	).toMatchObject({
		classId: "supplier-review",
		instruction: expect.stringContaining("80%"),
	});
	expect(learn([event(1)]).cardIntuitiveness?.percent).toBeNull();
	const strong = learn([
		observed(1, false),
		observed(2, false),
		observed(3, false),
		observed(4, false),
		observed(5, true),
	]);
	expect(strong.cardIntuitiveness?.percent).toBe(80);
	expect(strong.cardIntuitiveness?.classes[0]?.needsBetterSummary).toBe(false);
});
