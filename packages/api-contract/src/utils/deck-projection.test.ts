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
	it("keeps owner-only asks named in the subject and ignores the agent summary", () => {
		const ask = (id: string, subject: string, prompt = "Details follow.") =>
			row(id, {}, {
				request: { ...row(id).request, subject, prompt },
			} as Partial<Row>);
		expect(
			project([
				ask("money", "Delete the paused graph copy before it auto-resumes?"),
				ask(
					"tax",
					"Bookkeeping: answer 7 expense questions or name your tax adviser",
				),
				ask("drafts", "Review two prepared contact drafts — about 4 minutes"),
				ask("roles", "Change the membership back to the Member role"),
				ask(
					"agent",
					"Extend this lane scope to package.json and bun.lock",
					"Summary: no sends, publish later through the guarded push.",
				),
				ask("routine", "Owner/steward: mark Work complete"),
			])
				.map((card) => card.id)
				.sort(),
		).toEqual(["drafts", "money", "roles", "tax"]);
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

it("orders overdue, critical, due today, then the ranker's label ahead of score", () => {
	const ranked = (penalty: number) => ({
		interaction: {
			request: {
				metadata: {
					cardRevision: 2,
					curation: {
						schema: "tedix.deck-curation.v1",
						revision: 2,
						status: "open",
						successorId: null,
						penalty,
						reason: penalty ? "ranked_lower" : "valuable",
						evidenceRefs: [],
						model: "qwen",
						exampleIds: [],
					},
				},
			},
		},
	});
	const now = new Date("2026-10-20T07:00:00Z");
	const cards = [
		{ id: "noise-high-score", score: 500, ...ranked(-10) },
		{ id: "valuable", score: 5, ...ranked(0) },
		{ id: "today", dueAt: "2026-10-20T15:00:00Z", score: 1 },
		{ id: "critical", kind: "approval", score: 0 },
		{ id: "overdue", dueAt: "2026-10-19T15:00:00Z", score: 0 },
	] as unknown as Parameters<typeof compareDecisionFreshness>[0][];
	expect(
		cards
			.sort((a, b) => compareDecisionFreshness(a, b, now, "UTC"))
			.map((card) => (card as { id: string }).id),
	).toEqual(["overdue", "critical", "today", "valuable", "noise-high-score"]);
});

it("merges Work asks and factory rows: critical first, then factory score, then the existing order", () => {
	const now = new Date("2026-10-20T07:00:00Z");
	const cards = [
		{ id: "work-today", kind: "question", dueAt: "2026-10-20T15:00:00Z" },
		{ id: "factory-low", kind: "decision", factory: { score: 0.2 } },
		{ id: "work-high-rank", kind: "question", score: 50 },
		{ id: "factory-high", kind: "decision", factory: { score: 0.9 } },
		{ id: "factory-unscored", kind: "decision", factory: {}, score: 1 },
		{ id: "approval", kind: "approval" },
		{
			id: "factory-critical",
			kind: "decision",
			factory: { policyCritical: true, score: 0 },
		},
		{ id: "work-overdue", kind: "question", dueAt: "2026-10-19T15:00:00Z" },
	] as unknown as Parameters<typeof compareDecisionFreshness>[0][];
	const order = cards
		.sort((a, b) => compareDecisionFreshness(a, b, now, "UTC"))
		.map((card) => (card as { id: string }).id);
	expect(order).toEqual([
		"work-overdue",
		"approval",
		"factory-critical",
		"factory-high",
		"factory-low",
		"work-today",
		"work-high-rank",
		"factory-unscored",
	]);
	// Critical-first invariant: no non-critical card, however well scored, precedes a critical one.
	const lastCritical = Math.max(
		order.indexOf("approval"),
		order.indexOf("factory-critical"),
	);
	expect(order.indexOf("factory-high")).toBeGreaterThan(lastCritical);
});

it("ranks cards serving the top objective ahead of blocks reach, never ahead of settled order", () => {
	const now = new Date("2026-10-20T07:00:00Z");
	const grow = { id: "grow", title: "Grow sales", priority: 1, top: true };
	const keep = { id: "keep", title: "Keep dry", priority: 2, top: false };
	const cards = [
		{ id: "blocks-many", blocksScore: 9, objective: keep },
		{ id: "overdue", dueAt: "2026-10-19T15:00:00Z" },
		{ id: "top-plain", objective: grow },
		{ id: "top-blocks", blocksScore: 2, objective: grow },
		{ id: "top-settled", actionable: false, objective: grow },
	] as unknown as Parameters<typeof compareDecisionFreshness>[0][];
	const order = (list: typeof cards) =>
		[...list]
			.sort((a, b) => compareDecisionFreshness(a, b, now, "UTC"))
			.map((card) => (card as { id: string }).id);
	expect(order(cards)).toEqual([
		"top-blocks",
		"top-plain",
		"blocks-many",
		"overdue",
		"top-settled",
	]);
	// Cards with no top objective keep today's order.
	expect(order(cards.filter((card) => !card.objective?.top))).toEqual([
		"blocks-many",
		"overdue",
	]);
});

it("ignores an out-of-range factory score and falls back to the existing order", () => {
	const now = new Date("2026-10-20T07:00:00Z");
	const cards = [
		{ id: "invalid", kind: "decision", factory: { score: 7 }, score: 0 },
		{ id: "ranked", kind: "decision", factory: {}, score: 3 },
	] as unknown as Parameters<typeof compareDecisionFreshness>[0][];
	expect(
		cards
			.sort((a, b) => compareDecisionFreshness(a, b, now, "UTC"))
			.map((card) => (card as { id: string }).id),
	).toEqual(["ranked", "invalid"]);
});

it("keeps future deadlines visible in nearest-deadline order while respecting show-from", () => {
	const later = row("later", { decisionClass: "opportunity.new" });
	later.request.dueAt = "2026-10-23";
	const nearer = row("nearer", {
		decisionClass: "opportunity.new",
		showFrom: "2026-10-19",
	});
	nearer.request.dueAt = "2026-10-20";
	const hidden = row("hidden", {
		decisionClass: "opportunity.new",
		showFrom: "2026-10-20",
	});
	hidden.request.dueAt = "2026-10-21";
	const cards = project([later, hidden, nearer]);
	expect(cards.map((card) => card.id)).toEqual(["nearer", "later"]);
	expect(cards.map((card) => card.dueAt)).toEqual(["2026-10-20", "2026-10-23"]);
});
