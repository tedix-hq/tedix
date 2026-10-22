import { describe, expect, it } from "vite-plus/test";
import { DecisionEnvelopeSchema } from "@tedix/api-contract/schemas/os-decision-deck";
import { CardReviewSourceSchema } from "@tedix/api-contract/schemas/os-card-review";
import type { ReviewCard } from "@tedix/api-contract/utils/card-review";
import {
	type FactoryAutonomyEvent,
	factoryClassStanding,
} from "@tedix/api-contract/utils/factory-class-autonomy";
import {
	factoryCardDelivery,
	learnedClassDelivery,
} from "./decision-class-policy";
const decision = DecisionEnvelopeSchema.parse({
	version: 1,
	kind: "decision",
	classId: "filing",
	proposal: "File the receipt?",
	whyNow: "Ready",
	recommendation: "File",
	reversibility: "two_way",
	blastRadius: "One folder",
	confidence: 1,
	costOfWaiting: "None",
	reasoning: "Reversible",
	options: [
		{
			id: "yes",
			label: "Approve",
			intent: "approve",
			consequence: "Filed",
			cost: "None",
		},
		{
			id: "no",
			label: "Not this",
			intent: "reject",
			consequence: "Unchanged",
			cost: "None",
		},
	],
});
const events = Array.from({ length: 5 }, (_, i) => ({
	id: `${i}`,
	clientEventId: `decision-capture:${i}`,
	actorType: "user" as const,
	actorId: "fictional-user",
	targetId: `request-${i}`,
	metadata: {
		decisionClass: "filing",
		decisionChoice: "approve",
		feedbackSignal: "approve-as-is",
	},
	occurredAt: `2026-10-17T10:0${i}:00Z`,
}));
const input = {
	metadata: { decisionDeck: decision },
	policies: {
		filing: { autoApprove: true, unchangedThreshold: 5, auditSampleRate: 0.1 },
	},
	events,
	userId: "fictional-user",
	sample: 0.5,
};
describe("earned class delivery", () => {
	it("promotes after five distinct unchanged human approvals and keeps random audits", () => {
		expect(learnedClassDelivery(input)).toBe("auto");
		expect(learnedClassDelivery({ ...input, sample: 0.05 })).toBe("review");
		expect(
			learnedClassDelivery({
				...input,
				events: [...events.slice(0, 4), events[0]!],
			}),
		).toBe("review");
	});
	it("demotes immediately on rejection or correction", () => {
		for (const decisionChoice of ["reject", "change", "delegate"])
			expect(
				learnedClassDelivery({
					...input,
					events: [
						...events,
						{
							...events[0]!,
							id: "new",
							targetId: "new",
							occurredAt: "2026-10-18T10:00:00Z",
							metadata: {
								decisionClass: "filing",
								decisionChoice,
								feedbackSignal: "rejected",
							},
						},
					],
				}),
			).toBe("review");
	});
	it("never borrows another person's evidence or promotes protected, expired or unknown work", () => {
		expect(learnedClassDelivery({ ...input, userId: "other-person" })).toBe(
			"review",
		);
		expect(learnedClassDelivery({ ...input, policies: {} })).toBe("review");
		expect(
			learnedClassDelivery({
				...input,
				metadata: {
					decisionDeck: { ...decision, protectedEffects: ["production"] },
				},
			}),
		).toBe("review");
		expect(
			learnedClassDelivery({
				...input,
				metadata: { decisionDeck: { ...decision, reversibility: "unknown" } },
			}),
		).toBe("review");
	});
});

const factorySource = CardReviewSourceSchema.parse({
	label: "Forum",
	workspaceId: "11111111-1111-4111-8111-111111111111",
	cardSheetPrefix: "Forum cards ",
	columns: {
		type: "Type",
		source: "Thread",
		why: "Why",
		action: "Action",
		useful: "Useful?",
		reason: "Reason",
		done: "Done?",
	},
	doIt: "approve",
	scoring: {
		skipReasonChips: [
			{ label: "An agent could do it", mapsTo: "agent_could_do" },
		],
		agentDecidableClasses: ["upvote"],
	},
});
const factoryCard = (type = "Upvote", overrides: Partial<ReviewCard> = {}) =>
	({
		key: "sheet-1:9",
		sourceIndex: 0,
		sourceLabel: "Forum",
		channel: "",
		outputId: "sheet-1",
		sheetTitle: "Forum cards 2026-10-20",
		runCreatedAt: new Date().toISOString(),
		rowIndex: 9,
		number: "10",
		type,
		sourceText: "A helpful thread https://forum.example/t/1",
		link: "https://forum.example/t/1",
		who: "",
		why: "Answers a common question",
		ruleIds: [],
		action: "Upvote the answer",
		draft: "",
		useful: "",
		reason: "",
		done: "",
		result: "",
		score: 0.8,
		features: null,
		effort: "",
		timing: "",
		...overrides,
	}) satisfies ReviewCard;
const verdict = (
	i: number,
	decisionChoice: string,
	extra: Partial<FactoryAutonomyEvent> = {},
): FactoryAutonomyEvent => ({
	id: `verdict-${i}`,
	clientEventId: `client-${i}`,
	eventKind: decisionChoice === "not_useful" ? "rejected" : "accepted",
	surface: "decision_deck",
	actorType: "user",
	actorId: "fictional-user",
	targetId: `sheet-${i}`,
	occurredAt: `2026-10-20T10:${String(i).padStart(2, "0")}:00Z`,
	...extra,
	metadata: {
		decisionClass: "factory:Forum:Upvote",
		decisionChoice,
		rowIndex: i,
		...extra.metadata,
	},
});
const approvals = (n: number) =>
	Array.from({ length: n }, (_, i) => verdict(i, "do_it"));
const deliver = (
	events: FactoryAutonomyEvent[],
	overrides: Partial<Parameters<typeof factoryCardDelivery>[0]> = {},
) =>
	factoryCardDelivery({
		source: factorySource,
		card: factoryCard(),
		events,
		userId: "fictional-user",
		sample: 0.5,
		...overrides,
	});

describe("agent-decidable factory classes", () => {
	it("graduates a listed class only after five distinct unchanged Do it verdicts, with audits", () => {
		expect(deliver(approvals(4))).toBe("review");
		expect(deliver(approvals(5))).toBe("auto");
		expect(deliver(approvals(5), { sample: 0.05 })).toBe("review");
		expect(
			deliver([...approvals(4), { ...verdict(3, "do_it"), id: "again" }]),
		).toBe("review");
		expect(deliver(approvals(5), { userId: "other-person" })).toBe("review");
	});
	it("never graduates an unlisted class or one an explicit policy turns off", () => {
		expect(
			deliver(
				approvals(5).map((event) => ({
					...event,
					metadata: {
						...event.metadata,
						decisionClass: "factory:Forum:Follow",
					},
				})),
				{ card: factoryCard("Follow") },
			),
		).toBe("review");
		expect(
			deliver(approvals(5), {
				policies: {
					"factory:Forum:Upvote": {
						autoApprove: false,
						unchangedThreshold: 5,
						auditSampleRate: 0.1,
					},
				},
			}),
		).toBe("review");
	});
	it("counts agent-could-do marks as candidacy evidence but never graduates on them", () => {
		const marks = Array.from({ length: 40 }, (_, i) =>
			verdict(i, "not_useful", {
				metadata: { sharedReason: "agent_could_do" },
			}),
		);
		expect(deliver(marks)).toBe("review");
		expect(
			factoryClassStanding({
				source: factorySource,
				type: "upvote",
				events: marks,
				userId: "fictional-user",
			}),
		).toMatchObject({ status: "eligible", agentCouldDo: 40, unchanged: 0 });
	});
	it.each([
		"data",
		"contract",
		"production",
		"money",
		"consent",
		"message",
		"commitment",
	] as const)(
		"keeps a class with the protected effect %s with a person, whatever the feedback",
		(effect) => {
			const source = { ...factorySource, protectedEffects: [effect] };
			expect(deliver(approvals(50), { source })).toBe("review");
			expect(
				factoryClassStanding({
					source,
					type: "upvote",
					events: approvals(50),
					userId: "fictional-user",
				}),
			).toMatchObject({
				status: "blocked",
				blockers: [`protected:${effect}`],
			});
		},
	);
	it("keeps critical classes and human-reserved actions with a person", () => {
		for (const type of [
			"approval.money",
			"approval.delete",
			"send",
			"payment",
		]) {
			const source = CardReviewSourceSchema.parse({
				...factorySource,
				scoring: { ...factorySource.scoring, agentDecidableClasses: [type] },
			});
			const events = approvals(50).map((event) => ({
				...event,
				metadata: {
					...event.metadata,
					decisionClass: `factory:Forum:${type}`,
				},
			}));
			expect(deliver(events, { source, card: factoryCard(type) })).toBe(
				"review",
			);
			expect(
				factoryClassStanding({
					source,
					type,
					events,
					userId: "fictional-user",
				}).status,
			).toBe("blocked");
		}
		expect(
			deliver(approvals(50), {
				card: factoryCard("Upvote", { action: "Publish the answer" }),
			}),
		).toBe("review");
	});
	it("keeps outbound, approval, one-way, unknown and taste decisions with a person through the shared gate", () => {
		const policies = {
			"factory:Forum:Upvote": {
				autoApprove: true,
				unchangedThreshold: 5,
				auditSampleRate: 0.1,
			},
		};
		const evidence = Array.from({ length: 50 }, (_, i) => ({
			id: `${i}`,
			clientEventId: `decision-capture:${i}`,
			actorType: "user" as const,
			actorId: "fictional-user",
			targetId: `card-${i}`,
			metadata: {
				decisionClass: "factory:Forum:Upvote",
				decisionChoice: "approve",
				feedbackSignal: "approve-as-is",
			},
			occurredAt: `2026-10-17T10:${String(i).padStart(2, "0")}:00Z`,
		}));
		const run = (change: Record<string, unknown>) =>
			learnedClassDelivery({
				metadata: {
					decisionDeck: {
						...decision,
						classId: "factory:Forum:Upvote",
						...change,
					},
				},
				policies,
				events: evidence,
				userId: "fictional-user",
				sample: 0.5,
			});
		expect(run({})).toBe("auto");
		for (const change of [
			{ kind: "outbound" },
			{ kind: "approval" },
			{ reversibility: "one_way" },
			{ reversibility: "unknown" },
			{ tasteOrStrategy: true },
		])
			expect(run(change)).toBe("review");
	});
	it("does not graduate an expired card", () => {
		const source = CardReviewSourceSchema.parse({
			...factorySource,
			scoring: { ...factorySource.scoring, maxAgeDays: 1 },
		});
		expect(
			deliver(approvals(5), {
				source,
				card: factoryCard("Upvote", { runCreatedAt: "2026-01-01T00:00:00Z" }),
			}),
		).toBe("review");
	});
	it("demotes on an undo, a changed decision or an edit, and names the event", () => {
		const undo: FactoryAutonomyEvent = {
			id: "undo-1",
			clientEventId: "undo-1",
			eventKind: "undone",
			surface: "decision_learning",
			actorType: "user",
			actorId: "fictional-user",
			targetId: "verdict-2",
			occurredAt: "2026-10-20T11:00:00Z",
			metadata: { learningCorrection: true, correctsEventId: "verdict-2" },
		};
		expect(deliver([...approvals(5), undo])).toBe("review");
		expect(
			factoryClassStanding({
				source: factorySource,
				type: "upvote",
				events: [...approvals(5), undo],
				userId: "fictional-user",
			}),
		).toMatchObject({
			status: "candidate",
			unchanged: 0,
			demotion: { eventId: "undo-1", reason: "undo" },
		});
		const relearned = Array.from({ length: 5 }, (_, i) =>
			verdict(20 + i, "do_it", { occurredAt: `2026-10-20T12:0${i}:00Z` }),
		);
		expect(deliver([...approvals(5), undo, ...relearned])).toBe("auto");
		const changed = verdict(3, "not_useful", {
			id: "changed",
			occurredAt: "2026-10-20T11:00:00Z",
		});
		expect(deliver([...approvals(5), changed])).toBe("review");
		const edited = verdict(30, "do_it", {
			id: "edited",
			eventKind: "edited",
			occurredAt: "2026-10-20T11:00:00Z",
		});
		expect(deliver([...approvals(5), edited])).toBe("review");
		expect(
			deliver([...approvals(5), verdict(3, "useful", { id: "useful-first" })]),
		).toBe("auto");
	});
});
