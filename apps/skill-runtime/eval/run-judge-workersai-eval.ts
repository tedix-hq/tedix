/**
 * EXPERIMENT: Workers AI models as the stage-2 entailment judge.
 *
 * Measures whether a cheap Workers AI model can replace the chat-tedi judge
 * for entailment over the gold set. Same prompt (`buildJudgePrompt`), same
 * production ladder (`runEntailmentJudge` — here with single-item batches, the
 * natural shape for a stateless REST model), same span-check discipline: a
 * model that cannot copy a verbatim span out of the passage fails closed and
 * that failure is measured, not excused.
 *
 * Transport is the Workers AI REST chat-completions endpoint — the same one
 * `apps/api/eval/kernel/route-eval-sweep.ts` uses for kernel model sweeps.
 *
 * Usage (set CF_WORKERS_AI_TOKEN and CF_ACCOUNT_ID in the environment):
 *   bun run eval:judge:workersai                         # default candidates
 *   bun run eval:judge:workersai -- @cf/openai/gpt-oss-120b
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	buildJudgePrompt,
	type EntailmentJudgeItem,
	type EntailmentVerdict,
	JUDGE_PROMPT_VERSION,
	type JudgeStats,
	type ResolvedEntailment,
	runEntailmentJudge,
} from "../src/evidence-core";
import {
	loadGold,
	parseVerdictReply,
	REPO,
	type Score,
	scoreVerdicts,
} from "./judge-eval-shared";

const EVAL_DIR = path.dirname(fileURLToPath(import.meta.url));

// Per the live Workers AI catalog (models/search) there is no
// dedicated NLI model on Workers AI (Text Classification = sentiment +
// bge-reranker only, neither can produce a verbatim span or a contradiction
// label), and plain `llama-3.1-8b-instruct` is no longer listed — the cheap
// baseline is its fp8 variant.
const DEFAULT_CANDIDATES = [
	"@cf/meta/llama-3.1-8b-instruct-fp8", // cheap baseline
	"@cf/openai/gpt-oss-120b", // certified kernel fallback — best-known WAI JSON model
];

const models = (() => {
	const args = process.argv.slice(2).filter((a) => a.startsWith("@cf/"));
	return args.length > 0 ? args : DEFAULT_CANDIDATES;
})();

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID?.trim();
const API_TOKEN = process.env.CF_WORKERS_AI_TOKEN?.trim();
if (!ACCOUNT_ID || !API_TOKEN) {
	console.error(
		"CF_ACCOUNT_ID / CF_WORKERS_AI_TOKEN missing — set both in the environment.",
	);
	process.exit(1);
}

const REQUEST_TIMEOUT_MS = 90_000;
const MAX_OUTPUT_TOKENS = 1_200;

const gold = loadGold();
const items: EntailmentJudgeItem[] = gold.map((g) => ({
	id: g.id,
	claim: g.claim,
	passage: g.passage,
}));

/**
 * One judge call = one REST chat completion. The entire production judge prompt
 * rides as the user message, exactly as it rides `run_tedi_turn` in production;
 * `response_format: json_object` mirrors the kernel sweep's discipline for
 * models that support it.
 */
async function askWorkersAi(
	model: string,
	batch: EntailmentJudgeItem[],
): Promise<{ verdicts: Record<string, EntailmentVerdict>; latencyMs: number }> {
	const started = Date.now();
	try {
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${API_TOKEN}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					model,
					messages: [{ role: "user", content: buildJudgePrompt(batch) }],
					response_format: { type: "json_object" },
					max_tokens: MAX_OUTPUT_TOKENS,
				}),
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			},
		);
		const latencyMs = Date.now() - started;
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			console.error(`    HTTP ${response.status} ${detail.slice(0, 160)}`);
			return { verdicts: {}, latencyMs };
		}
		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: string | null } }>;
		};
		const raw = data.choices?.[0]?.message?.content ?? "";
		return { verdicts: parseVerdictReply(raw), latencyMs };
	} catch (error) {
		console.error(
			`    request failed: ${error instanceof Error ? error.name : "unknown"}`,
		);
		return { verdicts: {}, latencyMs: Date.now() - started };
	}
}

interface ModelRun {
	score: Score;
	stats: JudgeStats;
	judgeCalls: number;
	wallMs: number;
	meanLatencyMs: number;
	perItem: Record<
		string,
		{ goldLabel: string; label: string; status: string; correct: boolean }
	>;
}

const runs: Record<string, ModelRun> = {};

for (const model of models) {
	console.log(
		`\n=== Workers AI judge: ${model} (prompt ${JUDGE_PROMPT_VERSION}) ===`,
	);
	const startedAt = Date.now();
	let judgeCalls = 0;
	const latencies: number[] = [];
	const judgeFn = async (batch: EntailmentJudgeItem[]) => {
		judgeCalls++;
		const { verdicts, latencyMs } = await askWorkersAi(model, batch);
		latencies.push(latencyMs);
		console.log(
			`  call ${judgeCalls} [${batch.map((b) => b.id).join(",")}]: ${Object.keys(verdicts).length} verdict(s) ${latencyMs}ms`,
		);
		return batch
			.map((b) => verdicts[b.id])
			.filter(Boolean) as EntailmentVerdict[];
	};
	// Single-item batches: the stateless REST judge has no batching advantage,
	// and one item per call removes truncation/id-drift failure modes so the
	// experiment measures entailment quality, not reply bookkeeping.
	const { verdicts, stats } = await runEntailmentJudge(items, judgeFn, 1);
	const wallMs = Date.now() - startedAt;
	const score = scoreVerdicts(gold, verdicts);

	const perItem: ModelRun["perItem"] = {};
	for (const g of gold) {
		const v = verdicts.get(g.id) as ResolvedEntailment | undefined;
		if (!v) continue;
		perItem[g.id] = {
			goldLabel: g.goldLabel,
			label: String(v.label).toLowerCase(),
			status: v.status,
			correct: String(v.label).toLowerCase() === g.goldLabel,
		};
	}

	runs[model] = {
		score,
		stats,
		judgeCalls,
		wallMs,
		meanLatencyMs: latencies.length
			? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
			: 0,
		perItem,
	};
}

const dist = gold.reduce<Record<string, number>>((acc, g) => {
	acc[g.goldLabel] = (acc[g.goldLabel] ?? 0) + 1;
	return acc;
}, {});
console.log(`\n${"=".repeat(70)}`);
console.log(`GOLD: ${gold.length} items ${JSON.stringify(dist)}\n`);

for (const [model, run] of Object.entries(runs)) {
	const s = run.score;
	console.log(`${model}:`);
	console.log(`  resolved             ${s.resolved}/${gold.length}`);
	console.log(
		`  label accuracy       ${(s.labelAccuracy * 100).toFixed(1)}%  (${s.labelCorrect}/${s.resolved})`,
	);
	console.log(
		`  granted attributable ${s.grantedAttributable}   [FALSE grants: ${s.falseAttributable}, missed: ${s.missedAttributable}]`,
	);
	console.log(
		`  span rejections      ${s.spanRejected}  (asserted attributable, span not verbatim in passage)`,
	);
	console.log(
		`  ladder               resolved=${run.stats.resolved} retry=${run.stats.recoveredByRetry} fallback=${run.stats.recoveredByItemFallback} spanRepaired=${run.stats.spanRepaired} spanRejected=${run.stats.spanRejected}`,
	);
	console.log(`  confusion            ${JSON.stringify(s.confusion)}`);
	console.log(
		`  judge calls          ${run.judgeCalls}  (mean ${run.meanLatencyMs}ms, wall ${(run.wallMs / 1000).toFixed(1)}s)`,
	);
	console.log();
}

const resultsDir = path.join(EVAL_DIR, ".results");
fs.mkdirSync(resultsDir, { recursive: true });
const outPath = path.join(resultsDir, "last-workersai-run.json");
fs.writeFileSync(
	outPath,
	JSON.stringify(
		{ promptVersion: JUDGE_PROMPT_VERSION, models, runs },
		null,
		2,
	),
);
console.log(`wrote ${path.relative(REPO, outPath)}`);
