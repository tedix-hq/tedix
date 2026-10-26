import { describe, expect, it } from "vite-plus/test";
import { DecisionLearningConfigSchema } from "../schemas/decision-learning";
import {
	DeckPipelineConfigSchema,
	type DeckLearnedRule,
	type DeckSweepReceipt,
} from "../schemas/deck-pipeline";
import {
	deckPipelineStatus,
	deckSourceKey,
	deckWeekOneVerdicts,
	deriveDeckRule,
	evaluateDeckCreateGate,
	nextHidingClasses,
	notUsefulRetirement,
	planDeckSweep,
	subjectSimilarity,
	type SweepCard,
} from "./deck-pipeline";

const config = DeckPipelineConfigSchema.parse({});
const now = new Date("2026-10-21T08:00:00Z");
const agent = "11111111-1111-4111-8111-111111111111";

function card(overrides: Partial<SweepCard> = {}): SweepCard {
	return {
		id: crypto.randomUUID(),
		kind: "question",
		subject: "Choose the venue for the offsite",
		prompt: "Recommend the lakeside venue.",
		creatorType: "external_agent",
		creatorId: agent,
		workItemId: null,
		dueAt: null,
		expiresAt: null,
		createdAt: "2026-10-20T08:00:00Z",
		metadata: {},
		protected: false,
		askKind: "answer",
		...overrides,
	};
}

const envelope = {
	version: 1,
	kind: "decision",
	classId: "ops.venue",
	proposal: "Choose the venue?",
	whyNow: "Booking closes Friday.",
	recommendation: "Pick the lakeside venue.",
	reversibility: "two_way",
	blastRadius: "One booking",
	confidence: null,
	costOfWaiting: "The venue may be taken.",
	reasoning: "It fits the group.",
	options: [
		{
			id: "yes",
			label: "Yes",
			intent: "approve",
			consequence: "Books it.",
			cost: "None",
		},
		{
			id: "no",
			label: "No",
			intent: "reject",
			consequence: "Keeps looking.",
			cost: "Time",
		},
	],
};

describe("deck pipeline config", () => {
	it("defaults on, lives in the organization decision-learning config", () => {
		const parsed = DecisionLearningConfigSchema.parse({});
		expect(parsed.deckPipeline.createGate.mode).toBe("enforce");
		expect(parsed.deckPipeline.sweep.mode).toBe("enforce");
		expect(parsed.deckPipeline.sweep.duplicateSimilarity).toBe(1);
		expect(parsed.deckPipeline.earnedHiding.minUsefulCards).toBe(50);
		expect(parsed.deckPipeline.rules).toEqual([]);
	});

	it("rejects an invalid pattern", () => {
		expect(
			DeckPipelineConfigSchema.safeParse({ createGate: { askPattern: "(" } })
				.success,
		).toBe(false);
	});
});

describe("S0 create gate", () => {
	const gate = config.createGate;
	it("passes a structured decision with a recommendation and evidence", () => {
		expect(
			evaluateDeckCreateGate(
				{
					kind: "decision",
					subject: "Venue",
					prompt: "Pick one.",
					workItemId: agent,
					metadata: { decisionDeck: envelope },
				},
				gate,
				{ protected: false },
			),
		).toEqual({ verdict: "pass", missing: [], rule: null });
	});

	it("returns a status notice without a recommendation or evidence", () => {
		expect(
			evaluateDeckCreateGate(
				{
					kind: "question",
					subject: "Attempt failed",
					prompt: "Failed: the attempt stopped without a reported reason.",
					metadata: {},
				},
				gate,
				{ protected: false },
			),
		).toEqual({
			verdict: "bounce",
			missing: ["ask", "recommendation", "evidence"],
			rule: null,
		});
	});

	it("lets a protected ask through, flagged", () => {
		expect(
			evaluateDeckCreateGate(
				{
					kind: "question",
					subject: "Pay the invoice?",
					prompt: "x",
					metadata: {},
				},
				gate,
				{ protected: true },
			).verdict,
		).toBe("pass_protected");
	});

	it("bounces asks a learned rule says the agent handles itself", () => {
		const rule = { id: "rule-x" } as DeckLearnedRule;
		expect(
			evaluateDeckCreateGate(
				{
					kind: "decision",
					subject: "Venue",
					prompt: "Pick one.",
					workItemId: agent,
					metadata: { decisionDeck: envelope },
				},
				gate,
				{ protected: false, ruleBounce: rule },
			),
		).toEqual({ verdict: "bounce", missing: [], rule: "rule-x" });
	});

	it("does nothing when the organization turned the gate off", () => {
		expect(
			evaluateDeckCreateGate(
				{ kind: "question", subject: "", prompt: "", metadata: {} },
				{ ...gate, mode: "off" },
				{ protected: false },
			).verdict,
		).toBe("pass");
	});
});

describe("S2 sweep", () => {
	it("retires a hard-expired agent card, even a protected one", () => {
		const expired = card({
			protected: true,
			expiresAt: "2026-10-20T00:00:00Z",
		});
		const { actions } = planDeckSweep({
			cards: [expired],
			now,
			config: config.sweep,
			rules: [],
		});
		expect(actions).toMatchObject([
			{ cardId: expired.id, reason: "expired", cause: "expired" },
		]);
	});

	it("never retires on a missed due time: the ask is still actionable", () => {
		const overdue = card({ dueAt: "2026-10-01T00:00:00Z" });
		expect(
			planDeckSweep({ cards: [overdue], now, config: config.sweep, rules: [] })
				.actions,
		).toEqual([]);
	});

	it("retires cards whose Work Item finished", () => {
		const done = card({ workItemId: agent, workItemDisposition: "completed" });
		const kept = card({
			workItemId: agent,
			workItemDisposition: "completed",
			protected: true,
		});
		const { actions } = planDeckSweep({
			cards: [done, kept],
			now,
			config: config.sweep,
			rules: [],
		});
		expect(actions).toMatchObject([
			{ cardId: done.id, reason: "already_decided", workItemId: agent },
			{ cardId: kept.id, reason: "already_decided", workItemId: agent },
		]);
	});

	it("folds an exact duplicate into the newest card from the same agent", () => {
		const older = card({
			subject: "Publish the reply to Omar?",
			workItemId: agent,
		});
		const newer = card({
			subject: "Publish the reply to Omar",
			workItemId: agent,
			createdAt: "2026-10-20T09:00:00Z",
		});
		older.graph = { duplicates: [newer.id] };
		const other = card({
			subject: "Publish the reply to Omar",
			workItemId: null,
		});
		const { actions } = planDeckSweep({
			cards: [older, newer, other],
			now,
			config: config.sweep,
			rules: [],
		});
		expect(actions).toEqual([
			expect.objectContaining({
				cardId: older.id,
				reason: "duplicate",
				successorId: newer.id,
				note: `Merged into ${newer.id}.`,
			}),
		]);
	});

	it("folds a reminder into its original ask, never the original into the reminder", () => {
		const original = card({
			subject: "Authorize Devin in the consent tab",
			workItemId: agent,
		});
		const reminder = card({
			kind: "coordination",
			subject: "Needs you: Authorize Devin in the consent tab",
			creatorType: "system",
			creatorId: "tedix",
			workItemId: agent,
			createdAt: "2026-10-23T08:00:00Z",
			metadata: { laneNudge: { requestId: original.id, day: "2026-10-23" } },
		});
		original.graph = { duplicates: [reminder.id] };
		const { actions } = planDeckSweep({
			cards: [original, reminder],
			now,
			config: config.sweep,
			rules: [],
		});
		expect(actions).toEqual([
			expect.objectContaining({
				cardId: reminder.id,
				reason: "duplicate",
				successorId: original.id,
			}),
		]);
	});

	it("keeps similar but different asks", () => {
		const a = card({ subject: "Create a task to follow up with Oskar?" });
		const b = card({
			subject: "Create a follow-up task for Pierre?",
			createdAt: "2026-10-20T09:00:00Z",
		});
		expect(
			planDeckSweep({ cards: [a, b], now, config: config.sweep, rules: [] })
				.actions,
		).toEqual([]);
	});

	it("never folds a protected card into an unprotected one", () => {
		const older = card({ protected: true });
		const newer = card({ createdAt: "2026-10-20T09:00:00Z" });
		expect(
			planDeckSweep({
				cards: [older, newer],
				now,
				config: config.sweep,
				rules: [],
			}).actions,
		).toEqual([]);
	});

	it("applies learned rules to unprotected cards only; prior decisions require graph evidence", () => {
		const source = deckSourceKey(card());
		const rules: DeckLearnedRule[] = [
			{
				id: "rule-not-for-me",
				recipientId: "recipient",
				sourceKey: source,
				reason: "not_for_me",
				sentence: "Cards from agent stay out of your Decisions.",
				evidenceIds: ["a", "b", "c"],
				createdAt: now.toISOString(),
			},
		];
		const plain = card();
		const guarded = card({ protected: true, subject: "Pay the supplier" });
		const { actions } = planDeckSweep({
			cards: [plain, guarded],
			now,
			config: config.sweep,
			rules,
		});
		expect(actions).toMatchObject([
			{
				cardId: plain.id,
				reason: "no_longer_relevant",
				ruleId: "rule-not-for-me",
			},
		]);
		const decided = card({ subject: "Choose the venue for the offsite" });
		const result = planDeckSweep({
			cards: [decided],
			now,
			config: config.sweep,
			rules: [{ ...rules[0]!, id: "rule-decided", reason: "already_decided" }],
		});
		expect(result.actions).toEqual([]);
		expect(result.proposals).toEqual([]);
	});

	it("withdraws an ask the person taught is not worth their time, never a protected one", () => {
		const taught = card({ learnedFeed: true });
		const guarded = card({ learnedFeed: true, protected: true });
		expect(
			planDeckSweep({
				cards: [taught, guarded],
				now,
				config: config.sweep,
				rules: [],
			}).actions,
		).toEqual([
			expect.objectContaining({
				cardId: taught.id,
				reason: "no_longer_relevant",
				cause: "rule",
				note: "Withdrawn: you marked asks like this as not worth your time. Undo puts it back.",
			}),
		]);
	});

	it("keeps an open ask visible under an agent-could-do rule", () => {
		const ask = card();
		expect(
			planDeckSweep({
				cards: [ask],
				now,
				config: config.sweep,
				rules: [
					{
						id: "rule-agent",
						recipientId: "recipient",
						sourceKey: deckSourceKey(ask),
						reason: "agent_could_do",
						sentence: "Asks from agent go back to the agent to handle itself.",
						evidenceIds: ["a", "b", "c"],
						createdAt: now.toISOString(),
					},
				],
			}).actions,
		).toEqual([]);
	});

	it("is bounded by maxRetirementsPerRun", () => {
		const cards = Array.from({ length: 5 }, () =>
			card({ expiresAt: "2026-10-20T00:00:00Z" }),
		);
		expect(
			planDeckSweep({
				cards,
				now,
				config: { ...config.sweep, maxRetirementsPerRun: 2 },
				rules: [],
			}).actions,
		).toHaveLength(2);
	});
});

describe("S6 learning", () => {
	it("maps each chip to a retirement", () => {
		expect(notUsefulRetirement("already_decided")).toBe("handled_elsewhere");
		expect(notUsefulRetirement("expired")).toBe("expired");
		expect(notUsefulRetirement("duplicate")).toBe("duplicate");
		expect(notUsefulRetirement("not_for_me")).toBe("no_longer_relevant");
		expect(notUsefulRetirement("agent_could_do")).toBe("no_longer_relevant");
	});

	it("turns three identical reasons from one source into one rule", () => {
		const base = {
			recipientId: "recipient",
			sourceKey: "external_agent:abc:deck-truth",
			reason: "not_for_me" as const,
			existing: [],
			threshold: 3,
			now,
		};
		expect(deriveDeckRule({ ...base, evidenceIds: ["a", "b"] })).toBeNull();
		const rule = deriveDeckRule({ ...base, evidenceIds: ["a", "b", "c"] });
		expect(rule).toMatchObject({
			reason: "not_for_me",
			sentence: "Cards from deck-truth (agent) stay out of your Decisions.",
			evidenceIds: ["a", "b", "c"],
		});
		expect(
			deriveDeckRule({
				...base,
				evidenceIds: ["a", "b", "c", "d"],
				existing: [rule!],
			}),
		).toBeNull();
	});

	it("measures similarity on content words", () => {
		expect(subjectSimilarity("Publish the reply?", "publish reply")).toBe(1);
		expect(subjectSimilarity("Pay Omar", "Call Pierre")).toBe(0);
	});
});

describe("earned hiding", () => {
	const swipes = (count: number, wouldHideValuable = 0) =>
		Array.from({ length: count }, (_, index) => ({
			classKey: "answer|agent",
			valuable: true,
			wouldHide: index < wouldHideValuable,
		}));
	const hidingConfig = config.earnedHiding;

	it("stays off for the first 14 days whatever the evidence", () => {
		expect(
			nextHidingClasses({
				recipientId: "r",
				classes: [],
				swipes: swipes(80),
				undone: new Set(),
				config: hidingConfig,
				now,
			}),
		).toEqual([]);
	});

	it("turns on after 50 useful cards none of which it would hide, then off after 2 undos", () => {
		const later = new Date("2026-11-04T00:00:00Z");
		const promoted = nextHidingClasses({
			recipientId: "r",
			classes: [],
			swipes: swipes(50),
			undone: new Set(),
			config: hidingConfig,
			now: later,
		});
		expect(promoted).toMatchObject([
			{ classKey: "answer|agent", state: "hiding" },
		]);
		expect(
			nextHidingClasses({
				recipientId: "r",
				classes: [],
				swipes: swipes(50, 1),
				undone: new Set(),
				config: hidingConfig,
				now: later,
			}),
		).toEqual([]);
		const demoted = nextHidingClasses({
			recipientId: "r",
			classes: [{ ...promoted[0]!, recentHides: ["x", "y", "z"] }],
			swipes: [],
			undone: new Set(["x", "z"]),
			config: hidingConfig,
			now: later,
		});
		expect(demoted).toMatchObject([{ state: "shadow" }]);
	});
});

describe("status and week-1 metrics", () => {
	const receipt: DeckSweepReceipt = {
		at: "2026-10-21T07:00:00Z",
		mode: "enforce",
		recipients: 1,
		retired: 3,
		merged: 1,
		proposed: 0,
		ranked: 0,
		hidden: 0,
		wouldRetire: 0,
		errors: 0,
		removed: [],
		metrics: [
			{
				recipientId: "r",
				liveCards: 12,
				morning: { date: "2026-10-21", liveCards: 9 },
				notUseful: 3,
				settled: 20,
				wrongRemovals: 0,
				wrongProtectedRemovals: 0,
				removals: 10,
			},
		],
	};

	it("reports the last clean and flags a sweep older than 2 h", () => {
		const status = deckPipelineStatus(receipt, config, "r", now);
		expect(status).toMatchObject({
			lastCleanedAt: receipt.at,
			stale: false,
			metrics: { liveCards: 12 },
		});
		expect(
			deckPipelineStatus(receipt, config, "r", new Date("2026-10-21T09:30:00Z"))
				.stale,
		).toBe(true);
		expect(deckPipelineStatus(null, config, "r", now).stale).toBe(true);
	});

	it("scores the go/no-go thresholds", () => {
		expect(deckWeekOneVerdicts(receipt.metrics[0]!)).toMatchObject({
			liveCards: { value: 9, verdict: "go" },
			notUsefulRate: { value: 0.15, verdict: "go" },
			wrongRemovals: { verdict: "go" },
		});
		expect(
			deckWeekOneVerdicts({
				...receipt.metrics[0]!,
				morning: { date: "2026-10-21", liveCards: 16 },
				notUseful: 9,
				wrongProtectedRemovals: 1,
				wrongRemovals: 1,
			}),
		).toMatchObject({
			liveCards: { verdict: "no_go" },
			notUsefulRate: { verdict: "no_go" },
			wrongRemovals: { verdict: "no_go" },
		});
	});
});
