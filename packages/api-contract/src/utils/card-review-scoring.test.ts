import { describe, expect, it } from "vite-plus/test";
import {
	cardsFromSheet,
	factoryCardDecisionEnvelope,
	factoryVerdictLearning,
	parseCardFeatures,
	parseCardScore,
	reasonChips,
	reviewQueue,
	type ReviewCard,
	routeFactoryCard,
	scoredCards,
	skipReasonFor,
	verdictCells,
	whyThisCard,
} from "./card-review";
import { CardReviewSourceSchema } from "../schemas/os-card-review";

const source = CardReviewSourceSchema.parse({
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
		score: "Score",
		features: "Features",
		effort: "Effort",
		timing: "Timing",
	},
	doIt: "approve",
	protectedEffects: ["message"],
	scoring: {
		weights: { fresh_thread: 0.5, buyer_intent: 0.3, karma: 0.2 },
		topN: 2,
		maxAgeDays: 3,
		skipReasonChips: [
			{ label: "Already covered", mapsTo: "duplicate" },
			{ label: "Wrong topic", mapsTo: "not_for_me" },
			{ label: "Too much effort", mapsTo: null },
		],
		weightUpdate: { cadence: "weekly", mode: "shadow", minSamples: 30 },
		agentDecidableClasses: ["upvote"],
	},
});

const columns = [
	"Type",
	"Thread",
	"Why",
	"Action",
	"Useful?",
	"Reason",
	"Done?",
	"Score",
	"Features",
	"Effort",
	"Timing",
];

function sheet(
	outputId: string,
	runCreatedAt: string,
	rows: (string | null)[][],
): ReviewCard[] {
	const parsed = cardsFromSheet({
		source,
		sourceIndex: 0,
		outputId,
		sheetTitle: `Forum cards ${runCreatedAt.slice(0, 10)}`,
		runCreatedAt,
		body: { columns, rows },
	});
	if ("missing" in parsed) throw new Error("fixture columns missing");
	return parsed.cards;
}

const row = (
	thread: string,
	score: string,
	verdict: { useful?: string; reason?: string } = {},
) => [
	"Reply",
	`Example thread · https://forum.example/${thread}`,
	"Fresh question about setup",
	"Draft a reply",
	verdict.useful ?? "",
	verdict.reason ?? "",
	"",
	score,
	'{"fresh_thread":0.9,"buyer_intent":0.2,"karma":1,"note":"x"}',
	"5 min",
	"Today",
];

describe("scoring config", () => {
	it("defaults optional lists and rejects bad shapes", () => {
		const minimal = CardReviewSourceSchema.parse({
			...source,
			scoring: {},
		});
		expect(minimal.scoring).toEqual({
			weights: {},
			skipReasonChips: [],
			agentDecidableClasses: [],
		});
		for (const scoring of [
			{ weights: { "Not Snake": 1 } },
			{ topN: 0 },
			{ skipReasonChips: [{ label: "Stale", mapsTo: "stale" }] },
			{ weightUpdate: { cadence: "daily", mode: "shadow", minSamples: 5 } },
			{ unknown: true },
		])
			expect(
				CardReviewSourceSchema.safeParse({ ...source, scoring }).success,
			).toBe(false);
	});

	it("uses skip-reason chips as the Not useful chips", () => {
		expect(reasonChips(source, "notUseful")).toEqual([
			"Already covered",
			"Wrong topic",
			"Too much effort",
		]);
		expect(reasonChips({ ...source, scoring: undefined }, "notUseful")).toEqual(
			["Wrong person", "Not timely", "Too generic", "Already handled"],
		);
	});
});

describe("score and features columns", () => {
	it("parses valid cells and ignores unreadable ones", () => {
		expect(parseCardScore("0.75")).toBe(0.75);
		expect(parseCardScore("")).toBeNull();
		expect(parseCardScore("1.5")).toBeNull();
		expect(parseCardScore("high")).toBeNull();
		expect(parseCardFeatures('{"a":1,"b":"x","c":null}')).toEqual({ a: 1 });
		expect(parseCardFeatures("[1]")).toBeNull();
		expect(parseCardFeatures("{broken")).toBeNull();
		expect(parseCardFeatures("")).toBeNull();
	});

	it("reads score, features, effort and timing into the card", () => {
		const [card] = sheet("run-a", "2026-10-20T06:00:00Z", [row("1", "0.8")]);
		expect(card).toMatchObject({
			key: "run-a:0",
			score: 0.8,
			features: { fresh_thread: 0.9, buyer_intent: 0.2, karma: 1 },
			effort: "5 min",
			timing: "Today",
		});
	});

	it("leaves the fields empty on a sheet without the columns", () => {
		const parsed = cardsFromSheet({
			source,
			sourceIndex: 0,
			outputId: "old",
			sheetTitle: "Forum cards old",
			runCreatedAt: "2026-10-20T06:00:00Z",
			body: {
				columns: ["Thread", "Why", "Useful?", "Reason", "Done?"],
				rows: [["A thread", "Why", "", "", ""]],
			},
		});
		if ("missing" in parsed) throw new Error("fixture columns missing");
		expect(parsed.cards[0]).toMatchObject({
			score: null,
			features: null,
			effort: "",
			timing: "",
		});
	});

	it("asks on the Deck for a type the policy does not name as routine", () => {
		const route = (type: string) =>
			routeFactoryCard({ key: "k", type, sourceLabel: "Social" });
		expect(route("post draft (weekly recap)")).toMatchObject({
			destination: "deck",
			reason: "review",
		});
		expect(route("ops")).toMatchObject({
			destination: "feed",
			reason: "routine",
		});
		expect(route("opportunity")).toMatchObject({
			destination: "deck",
			reason: "valuable",
		});
	});

	it("passes the score through routing", () => {
		const [card] = sheet("run-a", "2026-10-20T06:00:00Z", [row("1", "0.8")]);
		expect(routeFactoryCard(card!).score).toBe(0.8);
		expect(
			routeFactoryCard({ key: "k", type: "Reply", sourceLabel: "Forum" }).score,
		).toBeNull();
	});
});

describe("scoredCards", () => {
	const now = new Date("2026-10-21T08:00:00Z");

	it("keeps the topN best scores per run day, ties in sheet order", () => {
		const cards = sheet("run-b", "2026-10-21T06:00:00Z", [
			row("1", "0.2"),
			row("2", "0.9"),
			row("3", "0.5"),
			row("4", "0.5"),
			row("5", ""),
		]);
		expect(
			scoredCards(cards, [source], now).map((card) => card.rowIndex),
		).toEqual([1, 2]);
		const tied = sheet("run-c", "2026-10-21T06:00:00Z", [
			row("1", "0.5"),
			row("2", "0.5"),
			row("3", "0.5"),
		]);
		expect(
			scoredCards(tied, [source], now).map((card) => card.rowIndex),
		).toEqual([0, 1]);
	});

	it("counts decided cards toward topN", () => {
		const cards = sheet("run-b", "2026-10-21T06:00:00Z", [
			row("1", "0.9", { useful: "yes" }),
			row("2", "0.8"),
			row("3", "0.7"),
		]);
		expect(
			scoredCards(cards, [source], now).map((card) => card.rowIndex),
		).toEqual([0, 1]);
	});

	it("drops cards from runs older than maxAgeDays", () => {
		const old = sheet("run-old", "2026-10-17T06:00:00Z", [row("9", "0.9")]);
		const fresh = sheet("run-new", "2026-10-21T06:00:00Z", [row("8", "0.1")]);
		expect(
			scoredCards([...old, ...fresh], [source], now).map((card) => card.key),
		).toEqual(["run-new:0"]);
	});

	it("collapses a card repeated across runs before topN, keeping stable keys", () => {
		const monday = sheet("run-mon", "2026-10-20T06:00:00Z", [
			row("same", "0.9"),
		]);
		const tuesday = sheet("run-tue", "2026-10-21T06:00:00Z", [
			row("same", "0.9"),
			row("other-1", "0.4"),
			row("other-2", "0.3"),
		]);
		const kept = scoredCards([...monday, ...tuesday], [source], now);
		expect(kept.map((card) => card.key)).toEqual(["run-tue:0", "run-tue:1"]);
		// Re-reading the same sheet after a verdict write yields the same keys.
		const reread = sheet("run-tue", "2026-10-21T06:00:00Z", [
			row("same", "0.9", { useful: "yes" }),
			row("other-1", "0.4"),
			row("other-2", "0.3"),
		]);
		expect(reread.map((card) => card.key)).toEqual(
			tuesday.map((card) => card.key),
		);
	});

	it("keeps a decided copy so a repeat does not come back", () => {
		const monday = sheet("run-mon", "2026-10-20T06:00:00Z", [
			row("same", "0.9", { useful: "no", reason: "Already covered" }),
		]);
		const tuesday = sheet("run-tue", "2026-10-21T06:00:00Z", [
			row("same", "0.9"),
		]);
		expect(
			scoredCards([...monday, ...tuesday], [source], now).map((c) => c.key),
		).toEqual(["run-mon:0"]);
	});

	it("passes sources without scoring through unchanged", () => {
		const cards = sheet("run-b", "2026-10-21T06:00:00Z", [
			row("1", "0.2"),
			row("1", "0.9"),
			row("3", "0.5"),
		]);
		expect(scoredCards(cards, [{ scoring: undefined }], now)).toEqual(cards);
	});
});

it("orders a run's open cards by factory score, then sheet order", () => {
	const cards = sheet("run-b", "2026-10-21T06:00:00Z", [
		row("1", "0.2"),
		row("2", ""),
		row("3", "0.9"),
	]);
	expect(
		reviewQueue(cards, {
			channel: null,
			snoozes: {},
			skipped: [],
			now: new Date("2026-10-21T08:00:00Z"),
		}).map((card) => card.rowIndex),
	).toEqual([2, 0, 1]);
});

describe("why this card", () => {
	it("names the two largest weighted features", () => {
		expect(
			whyThisCard(source, {
				features: { fresh_thread: 0.9, buyer_intent: 0.2, karma: 1 },
			}),
		).toBe("fresh thread, karma");
	});

	it("uses raw values without weights and skips non-positive inputs", () => {
		expect(
			whyThisCard(undefined, { features: { a_b: 0.1, c: 0.4, d: -1 } }),
		).toBe("c, a b");
		expect(whyThisCard(source, { features: { unweighted: 1 } })).toBeNull();
		expect(whyThisCard(source, { features: null })).toBeNull();
	});
});

describe("factory verdict feedback", () => {
	const [card] = sheet("run-a", "2026-10-20T06:00:00Z", [row("1", "0.8")]);

	it("maps skip chips onto shared reasons", () => {
		expect(skipReasonFor(source, "Already covered: seen it")).toEqual({
			factoryReason: "Already covered",
			sharedReason: "duplicate",
		});
		expect(skipReasonFor(source, "Too much effort, Wrong topic")).toEqual({
			factoryReason: "Wrong topic",
			sharedReason: "not_for_me",
		});
		expect(skipReasonFor(source, "Too much effort")).toEqual({
			factoryReason: "Too much effort",
			sharedReason: null,
		});
		expect(skipReasonFor(source, "free text only")).toBeNull();
	});

	it("records class, score, features and both reasons", () => {
		const reason = "Wrong topic: not our product";
		expect(
			verdictCells(source, card!, { kind: "not_useful", reason }),
		).toMatchObject({ Reason: reason });
		expect(factoryVerdictLearning(source, card!, reason)).toEqual({
			decisionClass: "factory:Forum:Reply",
			score: 0.8,
			features: { fresh_thread: 0.9, buyer_intent: 0.2, karma: 1 },
			factoryReason: "Wrong topic",
			sharedReason: "not_for_me",
		});
		expect(
			factoryVerdictLearning(
				{ label: "Forum", scoring: undefined },
				{ type: "", score: null, features: null },
				"Good catch",
			),
		).toEqual({ decisionClass: "factory:Forum:card" });
	});
});

describe("factoryCardDecisionEnvelope", () => {
	it("builds a proposal envelope keyed by the card type", () => {
		const [card] = sheet("run-a", "2026-10-20T06:00:00Z", [row("1", "0.8")]);
		const envelope = factoryCardDecisionEnvelope(source, card!);
		expect(envelope).toMatchObject({
			version: 1,
			kind: "proposal",
			classId: "reply",
			proposal: "Draft a reply",
			whyNow: "Fresh question about setup",
			protectedEffects: ["message"],
			confidence: 0.8,
			costOfWaiting: "Today",
			expiresAt: "2026-10-23T06:00:00.000Z",
		});
		expect(envelope.options.map((option) => option.intent)).toEqual([
			"approve",
			"reject",
		]);
		expect(
			factoryCardDecisionEnvelope(
				{ ...source, protectedEffects: undefined, scoring: undefined },
				{ ...card!, type: "", score: null },
			),
		).toMatchObject({
			classId: "card",
			protectedEffects: [],
			confidence: null,
		});
	});
});
