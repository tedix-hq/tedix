// @ts-nocheck — tenant workflow source, not app code. It executes inside the
// isolated Dynamic Worker with the (untyped) `env`/`step` the dispatch shim
// provides, exactly like every other skill's scripts/workflow.ts.
/**
 * Grounding Negative Drill — the FAILURE-path counterpart of the happy-path
 * grounding runs.
 *
 * The happy path (grounded run → publish) is proven repeatedly; the trust
 * claim lives in the failure path. This workflow forces a fully UNGROUNDED
 * run on purpose so every gate in the chain can be verified live:
 *
 *  1. `env.EVIDENCE.verify()` on three deliberately unverifiable items against
 *     a real page — a fabricated quote, a real-topic paraphrase whose claim
 *     the page never states, and a short/absurd quote that stage 1 must refuse
 *     to exact-match.
 *  2. One causal claim whose `evidenceIds` bind only to `attributable` items —
 *     there should be none, so `EVIDENCE.score()` must return
 *     `causalGroundingScore: 0` and seal it to `evidence/grounding.json`.
 *  3. The publish gate from the weekly-winners pattern, minus the side
 *     effects: compute `groundingOk` and RECORD which deliverable id the run
 *     WOULD write to — a run-scoped `drill:{runId}` id on failure, never the
 *     canonical one. The manifest grants no `mcp` tools, so this drill cannot
 *     publish anything even by accident.
 *  4. The dispatcher then evaluates the manifest policy
 *     (`grounding: { required: true, minCausalScore: 1 }`) and must seal a
 *     `grounding_below_min_causal_score` warning to `evidence/policy.json`.
 *
 * Negative-control honesty: if any item unexpectedly verifies, the drill logs
 * it loudly and continues — that outcome is data, not a crash.
 *
 * Canonical source: `apps/skill-runtime/eval/drill-ungrounded-workflow.ts`.
 * Republish with `bun eval/publish-drill-skill.ts`.
 */

const SOURCE_URL = "https://en.wikipedia.org/wiki/2026_European_heatwaves";

/**
 * Three items, three distinct failure lanes. All cite the same real, stable
 * page; none of them can legitimately verify against it (the page has no
 * hits for "Cooling Tower", "fan sales", "appliance", "40 percent"/"40%").
 */
const DRILL_ITEMS = [
	{
		// (a) FABRICATED quote — verbatim-looking, ≥28 normalized chars so it
		// takes the stage-1 exact-match lane and must miss, then reaches the
		// judge with a claim the page never states.
		subjectId: "drill-a-fabricated-quote",
		url: SOURCE_URL,
		quote:
			"The Cooling Tower 3000 desk fan became Europe's best-selling appliance overnight, with unit sales rising 4,100 percent in a single week.",
		claim:
			"The 2026 European heatwaves made the Cooling Tower 3000 desk fan the best-selling appliance in Europe.",
		title: "2026 European heatwaves - Wikipedia",
	},
	{
		// (b) Real-topic PARAPHRASE — the page discusses heatwaves and air
		// conditioning at length, but never states this sales figure or the
		// causal link. The textbook `extrapolatory` shape.
		subjectId: "drill-b-unstated-paraphrase",
		url: SOURCE_URL,
		quote:
			"Retailers across Germany reported that air conditioner sales rose by 40 percent during the June heatwave.",
		claim:
			"The 2026 European heatwaves caused a 40 percent increase in air-conditioner sales in Germany.",
		title: "2026 European heatwaves - Wikipedia",
	},
	{
		// (c) Valid URL, absurd near-empty quote — far below the 28-char stage-1
		// floor, so exact match must REFUSE it (a needle this short hits by
		// accident), and the judge gets an absurd unrelated claim it cannot
		// support from the passage. NOTE: the input schema requires quote length
		// ≥ 1, so a literally empty quote is rejected at the zod boundary before
		// any verification runs — "near-empty" is the strongest admissible form
		// of this probe. Note also: in the current ladder a short quote on a
		// scraped page still goes to the judge (the `quote_missing` reason is
		// unreachable from this path), so the expected failure class here is an
		// entailment reject, not `quote_missing`.
		subjectId: "drill-c-short-quote",
		url: SOURCE_URL,
		quote: "42?",
		claim: "The answer to everything is 42.",
		title: "2026 European heatwaves - Wikipedia",
	},
];

/**
 * Expected failure classes per item — informational; the HARD gate is that no
 * item lands `attributable`. Statuses list every conservative landing the
 * ladder can produce for that lane (a judge outage or an unparseable batch
 * reply degrades to `unsupported`, which still fails closed).
 */
const EXPECTED = {
	"drill-a-fabricated-quote": {
		statuses: ["extrapolatory", "contradictory", "unsupported"],
		reasons: [
			"entailment_extrapolatory",
			"entailment_contradictory",
			"entailment_unparseable",
			"entailment_unavailable",
			"judge_span_unverified",
			"judge_span_missing",
		],
	},
	"drill-b-unstated-paraphrase": {
		statuses: ["extrapolatory", "unsupported", "contradictory"],
		reasons: [
			"entailment_extrapolatory",
			"entailment_contradictory",
			"entailment_unparseable",
			"entailment_unavailable",
			"judge_span_unverified",
			"judge_span_missing",
		],
	},
	"drill-c-short-quote": {
		statuses: ["extrapolatory", "contradictory", "unsupported"],
		reasons: [
			"entailment_extrapolatory",
			"entailment_contradictory",
			"entailment_unparseable",
			"entailment_unavailable",
			"judge_span_unverified",
			"judge_span_missing",
		],
	},
};

/**
 * The canonical deliverable a real skill would overwrite on a grounded run.
 * The drill must never select it (and never writes to any deliverable at all).
 */
const CANONICAL_DELIVERABLE_ID = "grounding-negative-drill:canonical-report";

export default {
	async run(event, step, env) {
		// The workflow instance id is the run id (asserted at dispatch); the
		// reduced event envelope may omit it, so the dispatch params carry it too.
		const runId =
			(event && event.instanceId) ||
			(event && event.payload && event.payload.expectedRunId) ||
			"unknown-run";

		// 1. Verify the three unverifiable items. The verdicts are computed and
		//    sealed HOST-side; nothing this workflow does can author one.
		const evidence = await step.do(
			"verify unverifiable sources",
			{ timeout: "600 seconds" },
			async () => env.EVIDENCE.verify({ items: DRILL_ITEMS }),
		);

		// Negative-control honesty: nothing should verify. If something did, the
		// drill's premise is wrong — say so loudly and keep going; that is data.
		const unexpectedlyVerified = evidence
			.filter(
				(item) => item.verified === true || item.status === "attributable",
			)
			.map((item) => ({
				id: item.id,
				subjectId: item.subjectId,
				status: item.status,
				reason: item.reason,
			}));
		if (unexpectedlyVerified.length > 0) {
			console.warn(
				JSON.stringify({
					event: "drill.unexpected_verification",
					runId,
					items: unexpectedlyVerified,
				}),
			);
		}

		// 2. One causal claim, bound only to attributable evidence. With none,
		//    the claim cites nothing and the causal grounding score must be 0.
		const attributableIds = evidence
			.filter((item) => item.status === "attributable")
			.map((item) => item.id);

		const grounding = await step.do("score grounding", async () =>
			env.EVIDENCE.score({
				claims: [
					{
						id: "c1",
						kind: "causal",
						text: "The 2026 European heatwaves caused a surge in cooling-appliance sales across Europe.",
						evidenceIds: attributableIds,
					},
				],
				evidence,
			}),
		);

		// 3. The publish gate, exactly as the weekly-winners workflow
		//    computes it — but SIMULATED: this drill records the decision instead
		//    of acting on it. No record_artifact, no email_send, ever (the
		//    manifest grants no mcp tools, so the platform would refuse anyway).
		const gate = await step.do("publish gate simulation", () => {
			const groundingOk =
				grounding.causalGroundingScore >= 1 && grounding.attributableItems > 0;
			const wouldPublishTo = groundingOk
				? CANONICAL_DELIVERABLE_ID
				: `drill:${runId}`;
			return {
				groundingOk,
				wouldPublishTo,
				canonicalDeliverableId: CANONICAL_DELIVERABLE_ID,
				emailSuppressed: !groundingOk,
				sideEffectsExecuted: false,
			};
		});

		const verifySummary = evidence.map((item) => {
			const expected = EXPECTED[item.subjectId] || null;
			return {
				id: item.id,
				subjectId: item.subjectId,
				status: item.status,
				reason: item.reason,
				verified: item.verified,
				stage: item.stage,
				judgeLabel: item.judge ? item.judge.label : null,
				expectedStatuses: expected ? expected.statuses : null,
				expectedMatch: expected
					? expected.statuses.includes(item.status) &&
						expected.reasons.includes(item.reason)
					: null,
			};
		});

		return {
			drill: "grounding-negative",
			runId,
			groundingOk: gate.groundingOk,
			score: {
				causalGroundingScore: grounding.causalGroundingScore,
				groundingScore: grounding.groundingScore,
				evidenceItems: grounding.evidenceItems,
				attributableItems: grounding.attributableItems,
				exactMatches: grounding.exactMatches,
				entailedMatches: grounding.entailedMatches,
				causalClaims: grounding.causalClaims,
				groundedCausalClaims: grounding.groundedCausalClaims,
				unsupported: grounding.unsupported,
			},
			verifySummary,
			wouldPublishTo: gate.wouldPublishTo,
			emailSuppressed: gate.emailSuppressed,
			sideEffectsExecuted: gate.sideEffectsExecuted,
			unexpectedlyVerified,
		};
	},
};
