import { describe, expect, it } from "vite-plus/test";
import type { DeckCard } from "../schemas/attention";
import {
	DecideDeckCardRequestSchema,
	AttentionDisplayCardSchema,
} from "../schemas/attention";
import { DecisionEnvelopeSchema } from "../schemas/os-decision-deck";
import {
	deckDisplayCard,
	attentionMarkdown,
	attentionSource,
	feedDisplayCard,
} from "./attention-app-view";
const id = "11111111-1111-4111-8111-111111111111";
function payload(args: unknown) {
	return DecideDeckCardRequestSchema.parse(args).decision;
}
function raw(
	kind = "question",
	metadata: Record<string, unknown> = {},
): DeckCard {
	return {
		id,
		kind,
		label: "Original question",
		project: "Sample project",
		urgency: "later",
		decision: null,
		source: `/work?view=deck#card=${id}`,
		requestedAt: "2026-10-19T12:00:00Z",
		dueAt: null,
		score: 0,
		presentation: copy,
		interaction: {
			request: {
				id,
				kind,
				subject: "Original question",
				prompt: "Source prompt",
				metadata,
				version: 4,
				creatorType: "system",
			},
			canRespond: true,
			askedBy: "Sample assistant",
		},
	} as DeckCard;
}
const copy = {
	version: 2,
	context: "Your customer is waiting for a reply.",
	title: "Keep the prepared answer?",
	body: "Saves the answer for review.",
	recommendation: "The customer asked for these details.",
	stakes: "Due tomorrow",
};
describe("headless attention view adaptation", () => {
	it.each(["question", "input", "coordination"])(
		"preserves %s input and version fences",
		(kind) => {
			const view = deckDisplayCard(raw(kind, { cardPresentation: copy }), 0);
			expect(view).toMatchObject({
				ask: copy.title,
				ifYes: copy.body,
				why: copy.recommendation,
				stakes: copy.stakes,
				needsText: true,
			});
			const args = structuredClone(view.actions[0]!.arguments) as {
				decision: { decision: Record<string, unknown> };
			};
			args.decision.decision.body = "My answer";
			expect(payload(args)).toMatchObject({
				kind: "interaction",
				decision: {
					requestId: id,
					expectedRequestVersion: 4,
					body: "My answer",
					responseKind:
						kind === "question"
							? "answer"
							: kind === "input"
								? "input_provided"
								: "coordination_update",
				},
			});
			expect(AttentionDisplayCardSchema.parse(view)).toEqual(view);
		},
	);
	it("preserves stored decision, exception and outcome option identifiers", () => {
		for (const kind of ["decision", "exception", "outcome"]) {
			const view = deckDisplayCard(
				raw(kind, {
					decisionCard: {
						kind: "decision",
						options: [
							{ id: "keep", label: "Keep", body: "Keep the record." },
							{ id: "revise", label: "Revise" },
						],
					},
				}),
				0,
			);
			expect(view.actions.map((a) => a.id)).toEqual(["keep", "revise"]);
			expect(payload(view.actions[0]!.arguments)).toMatchObject({
				decision: {
					metadata: { cardAction: "keep" },
					body: "Keep the record.",
				},
			});
		}
	});
	it("keeps source ADR choices and does not resolve Later", () => {
		const card = raw("adr");
		card.decision = DecisionEnvelopeSchema.parse({
			version: 1,
			kind: "adr",
			classId: "technical.design",
			proposal: "Adopt the design?",
			whyNow: "The team needs a design.",
			recommendation: "Keep the smaller interface.",
			reversibility: "two_way",
			tasteOrStrategy: true,
			protectedEffects: [],
			blastRadius: "Sample project",
			confidence: null,
			costOfWaiting: "Design waits",
			reasoning: "Source reasoning",
			options: [
				{
					id: "adopt",
					label: "Adopt",
					intent: "approve",
					consequence: "Records the design.",
					cost: "None",
				},
				{
					id: "wait",
					label: "Later",
					intent: "later",
					consequence: "Keeps the decision open.",
					cost: "Delay",
				},
			],
		});
		const view = deckDisplayCard(card, 0);
		expect(view.actions.map((a) => a.id)).toEqual(["adopt", "wait"]);
		expect(payload(view.actions[1]!.arguments)).toMatchObject({
			decision: {
				resolvesRequest: false,
				metadata: { cardAction: "wait", decisionChoice: "later" },
			},
		});
	});
	it("keeps handoff execution in its originating OS flow", () => {
		const view = deckDisplayCard(raw("handoff"), 0);
		expect(view.actions).toEqual([]);
		expect(view.needsText).toBe(false);
		expect(view.source).toContain("#card=");
	});
	it.each(["Inbox", "Social"])(
		"keeps %s factory draft and sheet revision",
		(label) => {
			const card = raw("decision");
			delete card.interaction;
			card.id = "factory:sample";
			card.factory = {
				outputId: id,
				sourceIndex: 0,
				rowIndex: 2,
				revision: 7,
				draft: `Complete ${label} draft`,
				why: "Source reason",
				sourceText: "Source",
			};
			const view = deckDisplayCard(card, 2);
			expect(view.draft).toBe(`Complete ${label} draft`);
			expect(view.actions[0]!.textArgumentPath).toBe("/decision/reason");
			expect(
				payload({
					decision: {
						...(view.actions[0]!.arguments.decision as Record<string, unknown>),
						reason: "Useful because it answers the request.",
					},
				}),
			).toMatchObject({
				kind: "factory",
				expectedRevision: 7,
				verdict: "useful",
			});
		},
	);
	it("keeps critical and outbound approvals in the OS and never hides a supplied draft", () => {
		const critical = raw("approval", {
			riskLevel: "critical",
			cardPresentation: copy,
		});
		expect(deckDisplayCard(critical, 0).actions).toEqual([]);
		const outbound = raw("outbound", { schema: "tedix.outbound.v1" });
		outbound.factory = {
			outputId: id,
			sourceIndex: 0,
			rowIndex: 1,
			revision: 1,
			draft: "Full support draft",
			why: "Customer asked",
			sourceText: "Source",
		};
		const view = deckDisplayCard(outbound, 0);
		expect(view.actions).toEqual([]);
		expect(view.draft).toBe("Full support draft");
		expect(view.source).toContain("#card=");
	});
	it("does not trust a personal-agent attribution supplied by another actor", () => {
		const personal = {
			sourceAgentId: id,
			sourceAgentName: "Instinct",
			representedUserId: "member",
			sourceChannel: "webhook",
			capturedAt: "2026-10-19T12:00:00Z",
			evidenceUrl: "https://example.test/evidence",
			externalFindingId: "sample",
			kind: "proposal",
		};
		const card = raw("proposal", { personalAgentContribution: personal });
		expect(deckDisplayCard(card, 0).provenance).toBe(
			"Instinct · personal agent",
		);
		card.interaction!.request.creatorType = "user";
		expect(deckDisplayCard(card, 0).provenance).toBe("Sample assistant");
	});
	it("preserves Feed FYI provenance and offers no invented decision", () => {
		const item = {
			id: "finding",
			kind: "signal",
			sentence: "A useful finding",
			explanation: "Evidence from the source",
			source: "/work",
			actor: "Instinct",
			dueAt: null,
			personalAgentContribution: {
				sourceAgentName: "Instinct",
				evidenceUrl: "https://example.test/evidence",
			},
		} as Parameters<typeof feedDisplayCard>[0];
		const view = feedDisplayCard(item);
		expect(view).toMatchObject({
			provenance: "Instinct · personal agent",
			evidenceUrl: "https://example.test/evidence",
			actions: [],
		});
	});
	it("renders bounded Markdown and rejects unsafe source links", () => {
		const view = deckDisplayCard(raw(), 0);
		expect(attentionMarkdown([view], false)).toContain(
			"Some sources could not be read",
		);
		expect(attentionMarkdown([view], true)).toContain(
			"https://tedix.os.tedix.dev/work?view=deck#card=",
		);
		expect(attentionMarkdown([view], true).split("\n")[0]).not.toContain(id);
		expect(attentionMarkdown([view], true)).toContain(
			"Details: [Original request]",
		);
		expect(attentionMarkdown([], false)).not.toContain("Nothing needs");
		for (const source of [
			"javascript:alert(1)",
			"//example.test",
			"http://example.test",
		])
			expect(attentionSource(source)).toBe("https://tedix.os.tedix.dev/work");
	});
});
it("renders governed approval cards with OS fallback and no refused inline action", () => {
	const work = raw("approval");
	delete work.interaction;
	work.id = `work-approval:${id}`;
	work.workApproval = {
		canDecide: true,
		proposal: { id, version: 3, authorityKey: "delegation" },
		workItem: { riskLevel: "medium" },
	} as NonNullable<DeckCard["workApproval"]>;
	const delegation = deckDisplayCard(work, 0);
	expect(delegation.actions).toEqual([]);
	const runtime = raw("approval");
	delete runtime.interaction;
	runtime.id = `approval:${id}`;
	runtime.runtimeApproval = {
		id,
		actionType: "draft_local_note",
		review: { decisionMode: "approve_or_reject", interaction: null },
	} as NonNullable<DeckCard["runtimeApproval"]>;
	const tool = deckDisplayCard(runtime, 0);
	expect(tool.actions).toEqual([]);
	runtime.runtimeApproval.review.interaction = {
		type: "browser_takeover",
	} as NonNullable<
		NonNullable<DeckCard["runtimeApproval"]>["review"]["interaction"]
	>;
	expect(deckDisplayCard(runtime, 0).actions).toEqual([]);
});

it("offers supplied answers alongside free text without inventing an effect", () => {
	const view = deckDisplayCard(
		raw("question", { suggestedAnswers: ["Tuesday", "Thursday"] }),
		0,
	);
	expect(view.needsText).toBe(true);
	expect(view.options.map((o) => o.label)).toEqual(["Tuesday", "Thursday"]);
	expect(payload(view.actions[0]!.arguments)).toMatchObject({
		kind: "interaction",
		decision: { body: "Tuesday", metadata: { cardAction: "answer" } },
	});
	expect(view.actions.at(-1)!.textArgumentPath).toBe("/decision/decision/body");
});

it("keeps an explicitly pending projection from reviving stale saved copy", () => {
	const card = raw("question", { cardPresentation: copy });
	card.presentation = null;
	const view = deckDisplayCard(card, 0);
	expect(view.ask).not.toBe(copy.title);
	expect(view.context).toBeNull();
	expect(view.actions).toEqual([]);
	expect(attentionMarkdown([view], true)).not.toContain(copy.title);
});

it("keeps generation failure distinct from pending copy in MCP and Markdown faces", () => {
	const card = raw();
	card.presentation = null;
	card.faceText = "Summary unavailable. Open Details to review the source.";
	const view = deckDisplayCard(card, 0);
	expect(view.ask).toBe("Summary unavailable");
	expect(view.ifYes).toBe(card.faceText);
	expect(attentionMarkdown([view], true)).toContain("Summary unavailable");
	expect(view.actions).toEqual([]);
});
