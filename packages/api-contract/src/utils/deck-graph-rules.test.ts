import { describe, expect, it } from "vite-plus/test";
import { DeckPipelineConfigSchema } from "../schemas/deck-pipeline";
import type { DecisionGraphLink } from "../schemas/decision-graph";
import { planDeckSweep, type SweepCard } from "./deck-pipeline";
import { deckAsk } from "./deck-ask";
import { compareDecisionFreshness } from "./deck-projection";
const config = DeckPipelineConfigSchema.parse({});
const now = new Date("2026-10-22T12:00:00Z");
const card = (id: string, extra: Partial<SweepCard> = {}): SweepCard => ({
	id,
	kind: "question",
	subject: "Maple decision",
	prompt: "Recommend proceed",
	creatorType: "tedi",
	creatorId: "orchard",
	workItemId: null,
	dueAt: null,
	expiresAt: null,
	createdAt: "2026-10-20T12:00:00Z",
	metadata: {},
	protected: false,
	askKind: "decide",
	...extra,
});
const prior = {
	node: { kind: "owner_instruction", id: "lesson-orchard" },
	edge: {
		id: "edge",
		kind: "decided_by",
		from: { kind: "deck_card", id: "old" },
		to: { kind: "owner_instruction", id: "lesson-orchard" },
		source: "owner",
		confidence: 1,
		evidenceRef: "/lessons/lesson-orchard",
		note: "Renew Maple",
		occurredAt: "2026-10-20T12:00:00Z",
		createdAt: "2026-10-20T12:00:00Z",
	},
} satisfies DecisionGraphLink;
const plan = (...cards: SweepCard[]) =>
	planDeckSweep({
		cards,
		now,
		config: config.sweep,
		qualification: config.qualification,
		rules: [],
	});
describe("graph Deck qualification", () => {
	it("retires a linked prior decision even with unrelated wording and protection", () => {
		expect(
			plan(card("old", { protected: true, graph: { priorDecision: prior } }))
				.actions,
		).toMatchObject([
			{
				reason: "already_decided",
				note: "Already decided.",
				evidenceRefs: ["/lessons/lesson-orchard"],
			},
		]);
		expect(plan(card("same words")).actions).toEqual([]);
	});
	it("preserves remaining owner chores after a plan was decided", () => {
		expect(
			plan(
				card("task", { responseKind: "task", graph: { priorDecision: prior } }),
			).actions,
		).toEqual([]);
	});
	it("withdraws self-declared stale and blocked asks; keeps ordinary overdue asks", () => {
		const actions = plan(
			card("stale", {
				dueAt: "2026-10-20",
				prompt:
					"This deadline has passed. Check the source before asking for a fresh decision.",
				protected: true,
			}),
			card("blocked", {
				workItemId: "work-maple",
				workItemDisposition: "blocked",
			}),
			card("overdue", { dueAt: "2026-10-20" }),
		).actions;
		expect(actions.map((a) => a.cardId)).toEqual(["stale", "blocked"]);
		expect(actions.every((a) => a.reason === "expired")).toBe(true);
	});
	it("merges typed duplicates, never identical unlinked text", () => {
		const older = card("old", { graph: { duplicates: ["new"] } });
		const newer = card("new", {
			subject: "Different wording",
			createdAt: "2026-10-21T12:00:00Z",
		});
		expect(plan(older, newer, card("unlinked")).actions).toMatchObject([
			{ cardId: "old", successorId: "new", reason: "duplicate" },
		]);
	});
	it("follows supersedes direction even when the replacement is older", () => {
		expect(
			plan(
				card("old", {
					graph: {
						supersededBy: {
							...prior,
							node: { kind: "deck_card", id: "replacement" },
						},
					},
				}),
				card("replacement", { createdAt: "2026-10-19T12:00:00Z" }),
			).actions,
		).toMatchObject([
			{ cardId: "old", successorId: "replacement", reason: "superseded" },
		]);
	});
	it("ranks actionable blockers first and never promotes a stale overdue card", () => {
		const stale = deckAsk(
			{
				kind: "question",
				dueAt: "2026-10-20",
				request: {
					prompt: "Check the source before asking for a fresh decision.",
				},
			},
			now,
			{ qualification: config.qualification },
		);
		expect(stale).toMatchObject({ actionable: false, overdue: false });
		expect(
			compareDecisionFreshness(
				{ ...stale, blocksCount: 20 },
				{ actionable: true, blocksCount: 1 },
				now,
			),
		).toBeGreaterThan(0);
		expect(
			compareDecisionFreshness(
				{ actionable: true, blocksCount: 3 },
				{ actionable: true, blocksCount: 1, dueAt: "2026-10-20" },
				now,
			),
		).toBeLessThan(0);
	});
	it("honors D1 qualification switches", () => {
		const result = planDeckSweep({
			cards: [card("old", { graph: { priorDecision: prior } })],
			now,
			config: config.sweep,
			qualification: { ...config.qualification, enabled: false },
			rules: [],
		});
		expect(result.actions).toEqual([]);
	});
});

it("folds a linked duplicate chain into one live keeper", () => {
	const a = card("a", { graph: { duplicates: ["b"] } });
	const b = card("b", {
		createdAt: "2026-10-21T12:00:00Z",
		graph: { duplicates: ["a", "c"] },
	});
	const c = card("c", {
		createdAt: "2026-10-22T12:00:00Z",
		graph: { duplicates: ["b"] },
	});
	expect(plan(a, b, c).actions).toMatchObject([
		{ cardId: "b", successorId: "c" },
		{ cardId: "a", successorId: "c" },
	]);
});
