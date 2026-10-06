// @ts-nocheck — tenant workflow source, not app code. It executes inside the
// isolated Dynamic Worker with the (untyped) `env`/`step` the dispatch shim
// provides, exactly like every other skill's scripts/workflow.ts.
/**
 * Judge calibration — the dogfooding counterpart of `bun run eval:judge`.
 *
 * The repo harness answers "did WE change the judge?" (pinned to a commit,
 * gates a merge). This workflow answers "did the WORLD change under the judge?"
 * — the deployed prompt, the deployed ladder, the blind session path, and
 * whatever model currently serves `tedi.run_tedi_turn` — on a schedule, as a
 * normal durable skill run: sealed judge exchanges, step artifacts, dashboard
 * visibility, run history. Tedix measuring its own verifier with its own
 * primitives.
 *
 * GENERATED FILE CONTRACT: the canonical source of this workflow and its gold
 * set is the repo (`apps/skill-runtime/eval/`). `__GOLD__` is injected from
 * `judge-gold.json` by `publish-calibration-skill.ts`; edit there and
 * republish. Gold labels are human-authored — never regenerate them with a
 * model, which would measure agreement with a model instead of correctness.
 */
const GOLD = __GOLD__;

// Regression thresholds, set from the measured blinded baseline. A run is
// flagged when it does worse than the judge already is — ratchet these down as the judge
// improves, never up to make a red run green.
const THRESHOLDS = {
	minLabelAccuracy: 0.6,
	maxFalseGrants: 2,
	maxUnresolved: 4,
};

export default {
	async run(event, step, env) {
		const calibration = await step.do(
			"calibrate-judge",
			{ timeout: "600 seconds" },
			async () =>
				env.EVIDENCE.calibrate({
					items: GOLD.map((g) => ({
						id: g.id,
						claim: g.claim,
						passage: g.passage,
					})),
				}),
		);

		const scores = await step.do("score-calibration", () => {
			const byId = {};
			for (const g of GOLD) byId[g.id] = g;
			let resolved = 0;
			let labelCorrect = 0;
			let granted = 0;
			let falseGrants = 0;
			let missed = 0;
			const mismatches = [];
			for (const item of calibration.items) {
				const gold = byId[item.id];
				if (!gold) continue;
				const raw = String(item.label || "").toLowerCase();
				if (raw) resolved++;
				if (raw === gold.goldLabel) labelCorrect++;
				else
					mismatches.push({
						id: item.id,
						gold: gold.goldLabel,
						judge: raw || "unresolved",
						status: item.status,
						reason: item.reason,
					});
				// `status` is post-span-check — what production grounding would do.
				if (item.status === "attributable") {
					granted++;
					if (gold.goldLabel !== "attributable") falseGrants++;
				} else if (gold.goldLabel === "attributable") {
					missed++;
				}
			}
			return {
				goldItems: GOLD.length,
				resolved,
				labelCorrect,
				labelAccuracy: resolved
					? Math.round((labelCorrect / resolved) * 1000) / 1000
					: 0,
				granted,
				falseGrants,
				missed,
				spanRejected: calibration.stats.spanRejected,
				spanRepaired: calibration.stats.spanRepaired,
				mismatches,
			};
		});

		const healthy =
			scores.labelAccuracy >= THRESHOLDS.minLabelAccuracy &&
			scores.falseGrants <= THRESHOLDS.maxFalseGrants &&
			GOLD.length - scores.resolved <= THRESHOLDS.maxUnresolved;

		return {
			status: healthy ? "ok" : "attention",
			promptVersion: calibration.promptVersion,
			judge: calibration.judge,
			thresholds: THRESHOLDS,
			scores,
		};
	},
};
