/**
 * EXPERIMENT: self-consistency voting for the entailment judge.
 *
 * The single judge shows real run-to-run variance on IDENTICAL inputs
 * (measured 52.6–66.7% label accuracy across runs). This harness measures
 * whether majority voting over N independent samples of the same judge buys
 * that variance down, and what it costs.
 *
 * Design:
 *  - N (default 3) full passes over the gold set, each pass running the
 *    PRODUCTION ladder (`runEntailmentJudge`: batches of ≤4, one retry,
 *    per-item fallback, one span repair) against the live judge tedi.
 *  - Independence between votes: every judge call in every pass uses a
 *    Distinct session key (still under the production blind prefix
 *    `evidence:judge:` — the judge stays blind) and a distinct
 *    client_request_id, so a vote is a fresh sample, never an idempotent
 *    replay of a sibling vote. A per-run nonce keeps re-runs of this harness
 *    independent of each other too.
 *  - The span check is applied PER VERDICT by `resolveEntailmentLabel` inside
 *    the ladder, exactly like the single-judge path.
 *
 * Aggregation (abstain-toward-refusal):
 *  - majority raw label wins;
 *  - all votes disagree (or a tie) → `extrapolatory`;
 *  - majority says `attributable` but none of the majority's spans survived
 *    the span check → `extrapolatory`. A verified span from any majority vote
 *    carries the grant.
 *
 * Usage (needs a live gateway via the `tedix` CLI):
 *   bun run eval:judge:vote -- <tediSlug>        # N=3
 *   bun run eval:judge:vote -- <tediSlug> 5      # N=5
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type EntailmentJudgeItem,
	type EntailmentVerdict,
	type EvidenceStatus,
	JUDGE_PROMPT_VERSION,
	type JudgeStats,
	type ResolvedEntailment,
	runEntailmentJudge,
} from "../src/evidence-core";
import {
	askJudgeViaMcp,
	loadGold,
	REPO,
	type ScorableVerdict,
	type Score,
	scoreVerdicts,
} from "./judge-eval-shared";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));

const args = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const tedi = args[0];
if (!tedi) {
	console.error("usage: bun run eval:judge:vote -- <tediSlug> [votes]");
	process.exit(1);
}
const votes = Math.max(2, Number(args[1] ?? 3) || 3);

const gold = loadGold();
const items: EntailmentJudgeItem[] = gold.map((g) => ({
	id: g.id,
	claim: g.claim,
	passage: g.passage,
}));

// A fresh nonce per harness run: re-running the experiment must produce fresh
// samples, not replay a previous run's session keys / client_request_ids.
const nonce = Date.now().toString(36);

interface VoteAggregate extends ScorableVerdict {
	/** Raw labels of the resolved votes, in pass order. */
	votes: string[];
	/** "3-0" | "2-1" | "1-1-1" | … — distribution of resolved raw labels. */
	agreement: string;
	/** Passes that produced no verdict for this item. */
	missingVotes: number;
	/** True when the aggregate label was decided by unanimous votes. */
	unanimous: boolean;
	/** Verified span carried by the grant, when the aggregate is attributable. */
	span?: string;
}

function agreementShape(labels: string[]): string {
	const counts = new Map<string, number>();
	for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
	return [...counts.values()].sort((a, b) => b - a).join("-") || "0";
}

/**
 * Majority label wins. Ties (including full disagreement) and a majority
 * `attributable` whose spans all failed the span check resolve to
 * `extrapolatory` — when the samples cannot agree on a grant, refuse it.
 */
function aggregate(resolved: ResolvedEntailment[]): VoteAggregate | null {
	const labels = resolved.map((r) => String(r.label).toLowerCase());
	if (labels.length === 0) return null;

	const counts = new Map<string, number>();
	for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
	const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
	const top = ranked[0] as [string, number];
	const tie =
		ranked.length > 1 && (ranked[1] as [string, number])[1] === top[1];

	const base = {
		votes: labels,
		agreement: agreementShape(labels),
		missingVotes: votes - labels.length,
		unanimous: ranked.length === 1 && labels.length === votes,
	};

	if (tie) {
		return { ...base, label: "extrapolatory", status: "extrapolatory" };
	}

	const winner = top[0];
	if (winner === "attributable") {
		// The grant stands only on a vote whose span survived the check.
		const backed = resolved.find(
			(r) => String(r.label).toLowerCase() === "attributable" && r.spanVerified,
		);
		if (!backed) {
			// Majority asserted support, nobody could point at it. Abstain toward
			// refusal — this is the voting analogue of `judge_span_unverified`.
			return { ...base, label: "attributable", status: "extrapolatory" };
		}
		return {
			...base,
			label: "attributable",
			status: "attributable",
			span: backed.span,
		};
	}
	if (winner === "contradictory") {
		return { ...base, label: winner, status: "contradictory" };
	}
	if (
		winner === "extrapolatory" ||
		winner === "unsure" ||
		winner === "unclear"
	) {
		return { ...base, label: winner, status: "extrapolatory" };
	}
	// A majority of unrecognized labels is not a verdict.
	return { ...base, label: winner, status: "unsupported" as EvidenceStatus };
}

console.log(
	`\n=== self-consistency vote: ${tedi} × ${votes} (prompt ${JUDGE_PROMPT_VERSION}, nonce ${nonce}) ===`,
);

const startedAt = Date.now();
let judgeCalls = 0;
const passes: Array<Map<string, ResolvedEntailment>> = [];
const passStats: JudgeStats[] = [];
const passScores: Score[] = [];
const judgeExchanges: Array<{
	pass: number;
	call: number;
	items: string[];
	modelIdentity: { provider: string; model: string } | null;
	error?: string;
}> = [];

for (let pass = 1; pass <= votes; pass++) {
	console.log(`\n--- pass ${pass}/${votes} ---`);
	let call = 0;
	const judgeFn = async (batch: EntailmentJudgeItem[]) => {
		call++;
		judgeCalls++;
		const exchange = {
			pass,
			call,
			items: batch.map((item) => item.id),
		};
		let got: ReturnType<typeof askJudgeViaMcp>;
		try {
			got = askJudgeViaMcp(tedi, batch, `vote-${nonce}-p${pass}-c${call}`);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			judgeExchanges.push({
				...exchange,
				modelIdentity: null,
				error: message,
			});
			console.log(
				`  call ${call} (${batch.length} item${batch.length === 1 ? "" : "s"}): transport error (${message})`,
			);
			throw error;
		}
		judgeExchanges.push({
			...exchange,
			modelIdentity: got.modelIdentity,
		});
		console.log(
			`  call ${call} (${batch.length} item${batch.length === 1 ? "" : "s"}): ${Object.keys(got.verdicts).length} verdict(s) model=${got.modelIdentity ? `${got.modelIdentity.provider}/${got.modelIdentity.model}` : "unknown"}`,
		);
		return batch
			.map((b) => got.verdicts[b.id])
			.filter(Boolean) as EntailmentVerdict[];
	};
	const { verdicts, stats } = await runEntailmentJudge(items, judgeFn);
	passes.push(verdicts);
	passStats.push(stats);
	passScores.push(scoreVerdicts(gold, verdicts));
	console.log(
		`  pass ${pass}: resolved=${stats.resolved}/${items.length} retry=${stats.recoveredByRetry} fallback=${stats.recoveredByItemFallback} spanRepaired=${stats.spanRepaired} spanRejected=${stats.spanRejected}`,
	);
}

const aggregated = new Map<string, ScorableVerdict>();
const perItem: Record<
	string,
	VoteAggregate & { goldLabel: string; correct: boolean }
> = {};
const agreementDist: Record<string, number> = {};

for (const g of gold) {
	const resolved = passes
		.map((p) => p.get(g.id))
		.filter(Boolean) as ResolvedEntailment[];
	const agg = aggregate(resolved);
	if (!agg) continue;
	aggregated.set(g.id, agg);
	agreementDist[agg.agreement] = (agreementDist[agg.agreement] ?? 0) + 1;
	perItem[g.id] = {
		...agg,
		goldLabel: g.goldLabel,
		correct: agg.label === g.goldLabel,
	};
}

const wallMs = Date.now() - startedAt;
const score = scoreVerdicts(gold, aggregated);
const identityDist = judgeExchanges.reduce<Record<string, number>>(
	(acc, exchange) => {
		const key = exchange.error
			? "transport_error"
			: exchange.modelIdentity
				? `${exchange.modelIdentity.provider}/${exchange.modelIdentity.model}`
				: "unknown";
		acc[key] = (acc[key] ?? 0) + 1;
		return acc;
	},
	{},
);

const dist = gold.reduce<Record<string, number>>((acc, g) => {
	acc[g.goldLabel] = (acc[g.goldLabel] ?? 0) + 1;
	return acc;
}, {});
console.log(`\n${"=".repeat(70)}`);
console.log(`GOLD: ${gold.length} items ${JSON.stringify(dist)}\n`);
console.log(`${tedi} × ${votes} votes (majority, abstain-toward-refusal):`);
console.log(`  resolved             ${score.resolved}/${gold.length}`);
console.log(
	`  label accuracy       ${(score.labelAccuracy * 100).toFixed(1)}%  (${score.labelCorrect}/${score.resolved})`,
);
console.log(
	`  granted attributable ${score.grantedAttributable}   [FALSE grants: ${score.falseAttributable}, missed: ${score.missedAttributable}]`,
);
console.log(
	`  span rejections      ${score.spanRejected}  (majority asserted, no majority span survived)`,
);
console.log(`  confusion            ${JSON.stringify(score.confusion)}`);
console.log(`  vote agreement       ${JSON.stringify(agreementDist)}`);
console.log(`  model identity       ${JSON.stringify(identityDist)}`);
console.log(`  judge calls          ${judgeCalls}`);
console.log(`  wall time            ${(wallMs / 1000).toFixed(1)}s`);

console.log("\nper-item votes:");
for (const g of gold) {
	const item = perItem[g.id];
	if (!item) {
		console.log(
			`  ${g.id.padEnd(4)} gold=${g.goldLabel.padEnd(14)} UNRESOLVED`,
		);
		continue;
	}
	const mark = item.correct ? "✓" : "✗";
	console.log(
		`  ${g.id.padEnd(4)} gold=${g.goldLabel.padEnd(14)} votes=[${item.votes.join(", ")}]${item.missingVotes ? ` +${item.missingVotes} missing` : ""} -> ${item.label}/${item.status} ${mark}`,
	);
}

const resultsDir = path.join(EVAL_DIR, ".results");
fs.mkdirSync(resultsDir, { recursive: true });
const outPath = path.join(resultsDir, "last-vote-run.json");
fs.writeFileSync(
	outPath,
	JSON.stringify(
		{
			promptVersion: JUDGE_PROMPT_VERSION,
			judge: tedi,
			votes,
			nonce,
			score,
			agreementDist,
			judgeCalls,
			wallMs,
			passStats,
			passScores,
			identityDist,
			judgeExchanges,
			perItem,
		},
		null,
		2,
	),
);
console.log(`\nwrote ${path.relative(REPO, outPath)}`);
