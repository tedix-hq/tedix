/**
 * Entailment-judge calibration harness.
 *
 * Scores one or more tedi judges against a hand-labelled gold set.
 *
 * Uses the production prompt and verdict resolver, including the verbatim-span
 * check, through `runEntailmentJudge` from `evidence-core`. Prompt changes must
 * bump `JUDGE_PROMPT_VERSION`.
 *
 * The gold loader, the blind `run_tedi_turn` judge transport, and the scorer
 * live in `judge-eval-shared.ts`, shared with the voting and Workers AI harnesses.
 *
 * Usage (needs a live gateway via the `tedix` CLI):
 *   bun run eval:judge -- analyst           # one judge
 *   bun run eval:judge -- analyst cto       # + the self-preference bias experiment
 *
 * Gold labels come from a human reading the passage. Never regenerate them with
 * a model — that measures agreement with a model, not correctness.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	type EntailmentJudgeItem,
	type EntailmentVerdict,
	JUDGE_PROMPT_VERSION,
	type JudgeStats,
	type ResolvedEntailment,
	runEntailmentJudge,
} from "../src/evidence-core";
import {
	askJudgeViaMcp,
	loadGold,
	REPO,
	type Score,
	scoreVerdicts,
} from "./judge-eval-shared";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));

const gold = loadGold();
const judges = process.argv.slice(2).filter((a) => !a.startsWith("-"));
if (judges.length === 0) {
	console.error("usage: bun run eval:judge -- <tediSlug> [<tediSlug> …]");
	process.exit(1);
}

const items: EntailmentJudgeItem[] = gold.map((g) => ({
	id: g.id,
	claim: g.claim,
	passage: g.passage,
}));

// Session keys and client_request_id derive from the tag. A fresh nonce prevents
// gateway idempotency from returning a pending or completed previous run.
const nonce = Date.now().toString(36);

const all: Record<string, Map<string, ResolvedEntailment>> = {};
const ladderStats: Record<string, JudgeStats> = {};
const exchanges: Record<
	string,
	Array<{
		call: number;
		items: string[];
		modelIdentity: { provider: string; model: string } | null;
	}>
> = {};
for (const tedi of judges) {
	console.log(`\n=== judge: ${tedi} (prompt ${JUDGE_PROMPT_VERSION}) ===`);
	let call = 0;
	const judgeFn = async (batch: EntailmentJudgeItem[]) => {
		call++;
		const got = askJudgeViaMcp(tedi, batch, `${tedi}-${nonce}-${call}`);
		const tediExchanges = exchanges[tedi] ?? [];
		tediExchanges.push({
			call,
			items: batch.map((item) => item.id),
			modelIdentity: got.modelIdentity,
		});
		exchanges[tedi] = tediExchanges;
		console.log(
			`  call ${call} (${batch.length} item${batch.length === 1 ? "" : "s"}): ${Object.keys(got.verdicts).length} verdict(s) model=${got.modelIdentity ? `${got.modelIdentity.provider}/${got.modelIdentity.model}` : "unknown"}`,
		);
		return batch
			.map((b) => got.verdicts[b.id])
			.filter(Boolean) as EntailmentVerdict[];
	};
	const { verdicts, stats } = await runEntailmentJudge(items, judgeFn);
	all[tedi] = verdicts;
	ladderStats[tedi] = stats;
}

const dist = gold.reduce<Record<string, number>>((acc, g) => {
	acc[g.goldLabel] = (acc[g.goldLabel] ?? 0) + 1;
	return acc;
}, {});
console.log(`\n${"=".repeat(70)}`);
console.log(`GOLD: ${gold.length} items ${JSON.stringify(dist)}\n`);

const scored: Record<string, Score> = {};
for (const tedi of judges) {
	const s = scoreVerdicts(gold, all[tedi] ?? new Map());
	const ls = ladderStats[tedi];
	scored[tedi] = s;
	console.log(`${tedi}:`);
	console.log(`  resolved             ${s.resolved}/${gold.length}`);
	console.log(
		`  label accuracy       ${(s.labelAccuracy * 100).toFixed(1)}%  (${s.labelCorrect}/${s.resolved})`,
	);
	console.log(
		`  granted attributable ${s.grantedAttributable}   [FALSE grants: ${s.falseAttributable}, missed: ${s.missedAttributable}]`,
	);
	console.log(
		`  span rejections      ${s.spanRejected}  (judge asserted, span not in passage)`,
	);
	console.log(
		`  ladder               resolved=${ls?.resolved} retry=${ls?.recoveredByRetry} fallback=${ls?.recoveredByItemFallback} spanRepaired=${ls?.spanRepaired} spanRejected=${ls?.spanRejected}`,
	);
	console.log(`  confusion            ${JSON.stringify(s.confusion)}`);
}

if (judges.length === 2) {
	const [author, independent] = judges as [string, string];
	const a = scored[author]!;
	const b = scored[independent]!;
	let both = 0;
	let agree = 0;
	for (const g of gold) {
		const x = all[author]?.get(g.id);
		const y = all[independent]?.get(g.id);
		if (!x || !y) continue;
		both++;
		if (String(x.label).toLowerCase() === String(y.label).toLowerCase())
			agree++;
	}
	console.log(
		`\n--- SELF-PREFERENCE BIAS: ${author} (author) vs ${independent} (independent) ---`,
	);
	console.log(
		`  FALSE grants:        ${author}=${a.falseAttributable}   ${independent}=${b.falseAttributable}   (delta ${a.falseAttributable - b.falseAttributable})`,
	);
	console.log(
		`  label accuracy:      ${author}=${(a.labelAccuracy * 100).toFixed(1)}%   ${independent}=${(b.labelAccuracy * 100).toFixed(1)}%`,
	);
	console.log(
		`  inter-judge agreement: ${agree}/${both} (${both ? ((agree / both) * 100).toFixed(1) : 0}%)`,
	);
	console.log(
		`\n  A POSITIVE false-grant delta means the author waves its own claims through\n  more readily than a disinterested judge — the bias that would justify a\n  separate verifier tedi. Interpret the delta from this run alongside sample\n  size, unresolved items, and run-to-run variance.`,
	);
}

const resultsDir = path.join(EVAL_DIR, ".results");
fs.mkdirSync(resultsDir, { recursive: true });
const outPath = path.join(resultsDir, "last-run.json");
fs.writeFileSync(
	outPath,
	JSON.stringify(
		{
			promptVersion: JUDGE_PROMPT_VERSION,
			judges,
			scored,
			verdicts: all,
			exchanges,
		},
		null,
		2,
	),
);
console.log(`\nwrote ${path.relative(REPO, outPath)}`);
