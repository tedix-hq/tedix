import { learnDecisions } from "./decision-learning";
import { DecisionLearningConfigSchema } from "../schemas/decision-learning";
import { describe, expect, it } from "vite-plus/test";
import type * as z from "zod";
import type { WorkInteractionInboxRowSchema } from "../schemas/work-interactions";
import {
	rankDeckCard,
	projectDeckCards,
	compareDecisionFreshness,
} from "./deck-projection";
import { factoryCardDeadline } from "./card-schedule";

type Row = z.infer<typeof WorkInteractionInboxRowSchema>;
const now = new Date("2026-10-19T12:00:00.000Z");
function row(
	id: string,
	metadata: Record<string, unknown> = {},
	overrides: Partial<Row> = {},
): Row {
	return {
		request: {
			id,
			kind: "question",
			subject: "A worthwhile decision?",
			prompt: "What should happen next?",
			metadata,
			requestedAt: "2026-10-19T10:00:00.000Z",
			dueAt: null,
			projectId: null,
			workItemId: null,
		},
		effectiveState: "open",
		canRespond: true,
		...overrides,
	} as Row;
}
function project(requests: Row[]) {
	return projectDeckCards({
		requests,
		work: [],
		runtime: [],
		now,
		timeZone: "Europe/Berlin",
	});
}
const decision = {
	version: 1,
	kind: "outbound",
	classId: "customer.followup",
	proposal: "Send the prepared answer?",
	whyNow: "The customer is waiting.",
	recommendation: "Send the answer because it addresses the question.",
	preview: { body: "Full draft\n\nSecond paragraph with details." },
	reversibility: "one_way",
	tasteOrStrategy: false,
	protectedEffects: ["message"],
	blastRadius: "The customer receives the reply.",
	confidence: 0.9,
	costOfWaiting: "The issue remains unanswered.",
	reasoning: "The draft answers the customer.",
	lessons: [],
	options: [
		{
			id: "send",
			label: "Send",
			intent: "approve",
			consequence: "The reply is sent.",
			cost: "One message",
		},
		{
			id: "wait",
			label: "Wait",
			intent: "later",
			consequence: "No message is sent.",
			cost: "The customer waits",
		},
	],
};

describe("canonical Deck projection", () => {
	it("keeps valuable and critical decisions while hiding filing and status noise", () => {
		expect(
			project([
				row("filing", { decisionClass: "filing.request" }),
				row("fyi", {
					schema: "tedix.decision-capture.v1",
					attention: { kind: "fyi" },
				}),
				row("customer", { decisionDeck: decision }),
				row("opportunity", { decisionClass: "opportunity.new" }),
				row("critical", { riskLevel: "critical" }),
			]).map((card) => card.id),
		).toEqual(["customer", "critical", "opportunity"]);
	});
	it("preserves the complete draft and the canonical response version", () => {
		const original = row("customer", { decisionDeck: decision });
		original.request.version = 7;
		const [card] = project([original]);
		expect(card?.decision?.preview?.body).toBe(decision.preview.body);
		expect(card?.interaction?.request.version).toBe(7);
	});
	it("excludes another recipient, resolved, reviewing and future scheduled cards", () => {
		expect(
			project([
				row("other", { riskLevel: "critical" }, { canRespond: false }),
				row(
					"resolved",
					{ riskLevel: "critical" },
					{ effectiveState: "resolved" },
				),
				row("reviewing", {
					schema: "tedix.outbound.v1",
					outboundStatus: "reviewing",
					riskLevel: "critical",
				}),
				row("future", { riskLevel: "critical", scheduledAt: "2026-10-20" }),
			]),
		).toEqual([]);
	});
	it("puts overdue asks first, then approvals", () => {
		const expired = row("expired", { riskLevel: "critical" });
		expired.request.dueAt = "2026-10-18T12:00:00.000Z";
		expect(
			project([
				expired,
				row("fresh", { riskLevel: "critical" }),
				row("approval", {
					approvalOperation: "publish",
					approvalTarget: "a document",
				}),
			]).map((card) => card.id),
		).toEqual(["expired", "approval", "fresh"]);
	});
});

it("uses learned source and project weights for factories and approvals as well as interaction cards", () => {
	const model = learnDecisions({
		organizationId: "fictional-orchard",
		personId: "river",
		events: [],
		config: DecisionLearningConfigSchema.parse({ enabled: true }),
		now,
	});
	model.weights.personal.push({
		key: "source:decision_capture",
		value: 2,
		examples: 3,
		evidenceIds: ["choice1"],
	});
	model.weights.priority.push({
		key: "project:orchard-project",
		value: 3,
		examples: 3,
		evidenceIds: ["choice2"],
	});
	for (const kind of ["decision", "approval"]) {
		const card = {
			id: `${kind}:1`,
			kind,
			project: "orchard-project",
			urgency: "later",
			label: "Prepare the next step",
			decision: null,
		};
		const score = rankDeckCard(card, model, now);
		expect(score.score).toBeGreaterThan(0);
		expect(score.factors.flatMap((factor) => factor.evidenceIds)).toEqual(
			expect.arrayContaining(["choice1", "choice2"]),
		);
	}
});

it("keeps critical credential and consent requests whose subject carries the ask", () => {
	for (const subject of [
		"Replace my API key?",
		"Extend the organization consent?",
		"Allow this service to read my private records?",
	]) {
		const request = row(subject);
		request.request.subject = subject;
		request.request.prompt = "Continue the previously described setup.";
		expect(project([request]).map((card) => card.id)).toEqual([subject]);
	}
});

it("emits both admitted and withheld routing receipts without a human vote", () => {
	const routes: Array<{ id: string; destination: string; reason: string }> = [];
	const cards = projectDeckCards({
		requests: [
			row("filing", { decisionClass: "filing.request" }),
			row("outbound", { schema: "tedix.outbound.v1" }),
		],
		work: [],
		runtime: [],
		now,
		onRoute: (route) => routes.push(route),
	});
	expect(cards.map((card) => card.id)).toEqual(["outbound"]);
	expect(routes).toEqual([
		expect.objectContaining({
			id: "filing",
			destination: "feed",
			reason: "routine",
		}),
		expect.objectContaining({
			id: "outbound",
			destination: "deck",
			reason: "critical",
		}),
	]);
});

it("retains feed-routed questions and non-critical approvals in the full attention projection", () => {
	type Input = Parameters<typeof projectDeckCards>[0];
	const input: Input = {
		requests: [
			row("supplier-question"),
			row("other-recipient", {}, { canRespond: false }),
		],
		work: [
			{
				proposal: {
					id: "routine-work",
					authorityKey: "run_workflow",
					requestedAt: now.toISOString(),
					metadata: {},
				},
				workItem: {
					title: "Prepare fictional inventory",
					projectId: null,
					riskLevel: "low",
				},
				effectiveStatus: "pending",
				canDecide: true,
			},
		] as Input["work"],
		runtime: [
			{
				id: "routine-runtime",
				status: "pending",
				actionType: "run_workflow",
				payload: {},
				review: { intent: "workflow" },
				description: "Prepare fictional inventory",
				createdAt: now.toISOString(),
			},
		] as Input["runtime"],
		now,
	};
	expect(projectDeckCards(input)).toEqual([]);
	const full = projectDeckCards({ ...input, destination: "all" });
	expect(full.map((card) => card.id)).toEqual(
		expect.arrayContaining([
			"supplier-question",
			"work-approval:routine-work",
			"approval:routine-runtime",
		]),
	);
	expect(full).toHaveLength(3);
});

it("puts overdue first, then a dated factory deadline ahead of learned noise, keeping date-only deadlines current all day", () => {
	const dueAt = factoryCardDeadline({
		action: "Review invoice corrections by Tuesday 14:00?",
		why: "The buyer asks for updates by Tuesday 20 October at 14:00; timezone unstated.",
		runCreatedAt: "2026-10-19T16:00:00Z",
	});
	expect(dueAt).toBe("2026-10-20");
	const cards = [
		{ id: "noise", score: 1000 },
		{ id: "booth", dueAt: "2026-10-20T11:59:00Z", score: 24 },
		{ id: "invoice", dueAt, score: 15 },
		{ id: "expired", dueAt: "2026-10-18", score: 2000 },
	];
	const morning = new Date("2026-10-20T07:00:00Z");
	expect(
		cards
			.sort((a, b) => compareDecisionFreshness(a, b, morning, "Europe/Berlin"))
			.map((c) => c.id),
	).toEqual(["expired", "invoice", "booth", "noise"]);
	const invoice = cards.find((card) => card.id === "invoice")!;
	expect(
		compareDecisionFreshness(
			invoice,
			{ score: 9999 },
			new Date("2026-10-20T21:59:00Z"),
			"Europe/Berlin",
		),
	).toBeLessThan(0);
	// After the local day ends the date-only deadline is overdue and still leads.
	expect(
		compareDecisionFreshness(
			invoice,
			{ score: 9999 },
			new Date("2026-10-20T22:01:00Z"),
			"Europe/Berlin",
		),
	).toBeLessThan(0);
});

it("does not guess ambiguous, invalid, undated or cross-year factory deadlines", () => {
	const card = {
		action: "Review?",
		why: "",
		runCreatedAt: "2026-10-19T16:00:00Z",
	};
	for (const why of [
		"Meet on 20 October",
		"Due today",
		"Update by 31 February 2026",
		"Send by 1 January",
		"Send by 20 October or by 21 October",
	])
		expect(factoryCardDeadline({ ...card, why })).toBeNull();
	expect(
		factoryCardDeadline({ ...card, scheduleDates: ["2026-10-20T12:00:00Z"] }),
	).toBe("2026-10-20T12:00:00Z");
});

it("applies persisted negative ranking without hiding a card or demoting critical policy", () => {
	const state = {
		schema: "tedix.deck-curation.v1",
		revision: 2,
		status: "open",
		successorId: null,
		penalty: -10,
		reason: "ranked_lower",
		evidenceRefs: [],
		model: "fictional-model",
		exampleIds: [],
	};
	const original = rankDeckCard(
		{
			id: "ordinary",
			kind: "question",
			project: "",
			urgency: "later",
			label: "Template choice?",
			decision: null,
		},
		undefined,
		now,
		{ kind: "question", metadata: {} },
	);
	const lowered = rankDeckCard(
		{
			id: "ordinary",
			kind: "question",
			project: "",
			urgency: "later",
			label: "Template choice?",
			decision: null,
		},
		undefined,
		now,
		{ kind: "question", metadata: { curation: state, cardRevision: 2 } },
	);
	expect(lowered.score).toBe(original.score - 10);
	const protectedRank = rankDeckCard(
		{
			id: "critical",
			kind: "question",
			project: "",
			urgency: "later",
			label: "Template choice?",
			decision: null,
		},
		undefined,
		now,
		{
			kind: "question",
			metadata: { riskLevel: "critical", curation: state, cardRevision: 2 },
		},
	);
	expect(protectedRank.score).toBe(original.score);
});
