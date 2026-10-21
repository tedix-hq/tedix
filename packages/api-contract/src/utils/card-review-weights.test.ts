import { describe, expect, it } from "vite-plus/test";
import type { CardScoring } from "../schemas/os-card-review";
import {
	type FactoryVerdictEvent,
	factoryWeightSamples,
	fitFactoryWeights,
	proposeFactoryWeights,
	rankingAccuracy,
	weightProposalText,
} from "./card-review-weights";

function scoring(patch: Partial<CardScoring> = {}): CardScoring {
	return {
		weights: { fresh_thread: 0.2, buyer_intent: 0.6 },
		skipReasonChips: [],
		agentDecidableClasses: [],
		topN: 5,
		weightUpdate: { cadence: "weekly", mode: "shadow", minSamples: 20 },
		...patch,
	};
}

const source = (patch: Partial<CardScoring> = {}) => ({
	label: "Forum",
	scoring: scoring(patch),
});

let seq = 0;
function verdict(
	choice: string,
	features: Record<string, number> | null,
	patch: Partial<FactoryVerdictEvent> & {
		meta?: Record<string, unknown>;
	} = {},
): FactoryVerdictEvent {
	seq += 1;
	const { meta, ...rest } = patch;
	return {
		id: `event-${seq}`,
		actorType: "user",
		actorId: "reviewer-a",
		targetId: "sheet-1",
		occurredAt: new Date(Date.UTC(2026, 9, 1, 0, seq)).toISOString(),
		metadata: {
			decisionClass: "factory:Forum:Reply",
			decisionChoice: choice,
			rowIndex: seq,
			...(features ? { features } : {}),
			...meta,
		},
		...rest,
	};
}

/** Useful cards are fresh threads; Not useful ones show buyer intent on old threads. */
function fixture(count: number, actorId = "reviewer-a") {
	return Array.from({ length: count }, (_, i) =>
		i % 2 === 0
			? verdict(
					"useful",
					{ fresh_thread: 0.8 + (i % 4) * 0.05, buyer_intent: 0.2 },
					{ actorId },
				)
			: verdict(
					"not_useful",
					{ fresh_thread: 0.15, buyer_intent: 0.75 + (i % 3) * 0.05 },
					{
						actorId,
						meta: { factoryReason: "Wrong topic", sharedReason: "not_for_me" },
					},
				),
	);
}

describe("factoryWeightSamples", () => {
	it("labels useful and do it positive, not useful negative, and drops the rest", () => {
		const samples = factoryWeightSamples(source(), [
			verdict("useful", { fresh_thread: 1 }),
			verdict("do_it", { fresh_thread: 1 }),
			verdict("not_useful", { fresh_thread: 0 }),
			verdict("skip", { fresh_thread: 1 }),
			verdict("later", { fresh_thread: 1 }),
			verdict("useful", null),
			verdict(
				"useful",
				{ fresh_thread: 1 },
				{
					meta: { decisionClass: "factory:Inbox:Reply" },
				},
			),
		]);
		expect(samples.map((s) => s.label)).toEqual([1, 1, 0]);
	});

	it("keeps a reviewer's latest verdict on one card", () => {
		const first = verdict(
			"useful",
			{ fresh_thread: 1 },
			{ meta: { rowIndex: 7 } },
		);
		const second = verdict(
			"not_useful",
			{ fresh_thread: 1 },
			{
				meta: { rowIndex: 7 },
			},
		);
		expect(factoryWeightSamples(source(), [second, first])).toEqual([
			expect.objectContaining({ label: 0 }),
		]);
	});

	it("counts a skip reason by its configured or default weight", () => {
		const samples = factoryWeightSamples(
			source({
				weightUpdate: {
					cadence: "weekly",
					mode: "shadow",
					minSamples: 1,
					reasonWeights: { "Too much effort": 0 },
				},
			}),
			[
				verdict(
					"not_useful",
					{ fresh_thread: 1 },
					{
						meta: {
							factoryReason: "Already covered",
							sharedReason: "duplicate",
						},
					},
				),
				verdict(
					"not_useful",
					{ fresh_thread: 1 },
					{
						meta: { factoryReason: "Too much effort", sharedReason: null },
					},
				),
				verdict("not_useful", { fresh_thread: 1 }),
			],
		);
		expect(samples.map((s) => s.weight)).toEqual([0.25, 1]);
		expect(samples[0]!.reason).toBe("Already covered");
	});

	it("keeps reviewer ids only for signed-in people", () => {
		const [sample] = factoryWeightSamples(source(), [
			verdict(
				"useful",
				{ fresh_thread: 1 },
				{ actorType: "tedi", actorId: "t-1" },
			),
		]);
		expect(sample!.reviewerId).toBeNull();
	});
});

describe("fitFactoryWeights", () => {
	it("moves weights toward the verdicts, bounded per weight", () => {
		const samples = factoryWeightSamples(source(), fixture(40));
		const fitted = fitFactoryWeights(
			{ fresh_thread: 0.2, buyer_intent: 0.6 },
			samples,
			0.25,
		);
		expect(fitted.fresh_thread).toBeGreaterThan(0.2);
		expect(fitted.fresh_thread).toBeLessThanOrEqual(0.45);
		expect(fitted.buyer_intent).toBeLessThan(0.6);
		expect(fitted.buyer_intent).toBeGreaterThanOrEqual(0.35);
		expect(rankingAccuracy(fitted, samples)).toBeGreaterThan(
			rankingAccuracy({ fresh_thread: 0.2, buyer_intent: 0.6 }, samples)!,
		);
	});

	it("keeps weights the samples never carry", () => {
		const samples = factoryWeightSamples(source(), fixture(10));
		expect(
			fitFactoryWeights({ author_karma: 0.4, fresh_thread: 0.1 }, samples)
				.author_karma,
		).toBe(0.4);
	});
});

describe("proposeFactoryWeights", () => {
	it("proposes weights with a held-out report", () => {
		const proposal = proposeFactoryWeights({
			source: source(),
			samples: factoryWeightSamples(source(), fixture(40)),
		});
		expect(proposal.status).toBe("ready");
		expect(proposal.previousWeights).toEqual({
			fresh_thread: 0.2,
			buyer_intent: 0.6,
		});
		expect(proposal.report).toMatchObject({
			samples: 40,
			positives: 20,
			negatives: 20,
			heldOut: 10,
			topN: 5,
			reasons: { "Wrong topic": 20 },
		});
		expect(proposal.report.accuracyAfter!).toBeGreaterThan(
			proposal.report.accuracyBefore!,
		);
		expect(weightProposalText(proposal)).toMatch(
			/^Retune card weights from 40 verdicts \(20 useful, 20 not useful\): fresh thread 0\.20 → 0\.\d\d; buyer intent 0\.60 → 0\.\d\d\. Held-out ranking accuracy \d+% → \d+% on the newest 10; \d+ of the top 5 cards would change\./,
		);
	});

	it("proposes nothing below minSamples", () => {
		const proposal = proposeFactoryWeights({
			source: source(),
			samples: factoryWeightSamples(source(), fixture(19)),
		});
		expect(proposal.status).toBe("insufficient");
		expect(proposal.weights).toEqual(proposal.previousWeights);
		expect(proposal.report.note).toBe("19 of 20 verdicts with features");
	});

	it("reports no change when the weights already rank the verdicts", () => {
		const good = { fresh_thread: 0.9, buyer_intent: -0.5 };
		const proposal = proposeFactoryWeights({
			source: source({
				weights: good,
				weightUpdate: {
					cadence: "weekly",
					mode: "shadow",
					minSamples: 20,
					maxChange: 0.01,
				},
			}),
			samples: factoryWeightSamples(source(), fixture(40)).map((s) => ({
				...s,
				reviewerId: null,
			})),
		});
		expect(proposal.report.accuracyBefore).toBe(1);
		expect(["no_change", "ready"]).toContain(proposal.status);
		if (proposal.status === "ready")
			expect(proposal.report.accuracyAfter).toBe(1);
	});

	it("learns reviewer weights only for reviewers with minSamples of their own", () => {
		const events = [...fixture(24, "reviewer-a"), ...fixture(6, "reviewer-b")];
		const proposal = proposeFactoryWeights({
			source: source(),
			samples: factoryWeightSamples(source(), events),
		});
		expect(Object.keys(proposal.reviewerWeights)).toEqual(["reviewer-a"]);
		expect(proposal.report.reviewers).toBe(1);
		expect(
			proposal.reviewerWeights["reviewer-a"]!.fresh_thread,
		).toBeGreaterThan(0.2);
	});
});
