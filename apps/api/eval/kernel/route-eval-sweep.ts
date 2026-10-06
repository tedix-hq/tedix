/**
 * Live-provider route-eval sweep across candidate Workers AI models.
 *
 * Replays the EXACT production Workers-AI route-planner request (SYSTEM_PROMPT
 * + in-prompt JSON Schema + buildUserPrompt over a realistic org fixture +
 * response_format json_object + the same fence-strip/normalize/zod pipeline)
 * against each candidate model via the Workers AI REST API, and scores:
 *
 *   - schemaOk:  output parsed + passed KernelRouteDecisionSchema
 *   - routeOk:   routeKind matched the scenario expectation
 *   - targetOk:  delegation target matched (when the scenario pins one)
 *   - traps:     the live-failure regression cases (workflow-keyword bait,
 *                verify-question fabrication) scored explicitly
 *
 * This is the way to change the kernel's model: graded suite first,
 * no-regression before a wrangler.jsonc flip.
 *
 * Run with CF_WORKERS_AI_TOKEN and CF_ACCOUNT_ID set in the environment:
 *   bun apps/api/eval/kernel/route-eval-sweep.ts
 *
 * A sweep has a five-minute total budget by default. `--json` emits a
 * prompt-free scorecard with a `nextCursor`; pass that value back through
 * `--cursor` to resume an incomplete sweep without re-running finished cases.
 */

import * as z from "zod";
import type { KernelContext } from "../../src/rpc/routers/kernel/context-assembly";
import {
	buildUserPrompt,
	SYSTEM_PROMPT,
} from "../../src/rpc/routers/kernel/route-planner";
import {
	KernelRouteDecisionSchema,
	normalizeRouteDecisionCandidate,
} from "../../src/rpc/routers/kernel/route-schema";
import type { TediCapabilityCard } from "../../src/rpc/routers/kernel/tedi-capabilities";

// ─── Candidates ──────────────────────────────────────────────────────────────

const ALL_CANDIDATE_MODELS = [
	"@cf/openai/gpt-oss-120b", // comparison baseline
	"@cf/moonshotai/kimi-k2.6",
	"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	"@cf/meta/llama-3.1-8b-instruct-fast", // cheap baseline
] as const;

// Optional substring filter: `--models gpt-oss,llama-3.3` (or SWEEP_MODELS env)
// runs only matching candidates. A prompt-change gate only needs the certified
// pair (~5 min); the full 4-model comparison (~30 min — kimi averages >15s per
// call and its timeouts burn the 90s budget) is for model-swap evaluations.
function selectCandidateModels(): readonly string[] {
	const argIdx = process.argv.indexOf("--models");
	const raw =
		(argIdx >= 0 ? process.argv[argIdx + 1] : undefined) ??
		process.env.SWEEP_MODELS;
	if (!raw?.trim()) return ALL_CANDIDATE_MODELS;
	const needles = raw
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter(Boolean);
	const picked = ALL_CANDIDATE_MODELS.filter((m) =>
		needles.some((n) => m.toLowerCase().includes(n)),
	);
	if (picked.length === 0) {
		console.error(
			`--models "${raw}" matched no candidates; running the full list.`,
		);
		return ALL_CANDIDATE_MODELS;
	}
	return picked;
}
const CANDIDATE_MODELS = selectCandidateModels();

const ATTEMPTS_PER_SCENARIO = 2;
const MAX_OUTPUT_TOKENS = 3000;
const REQUEST_TIMEOUT_MS = 90_000;
const DEFAULT_TOTAL_BUDGET_MS = 300_000;

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID?.trim();
if (!ACCOUNT_ID) {
	throw new Error(
		"route-eval-sweep requires CF_ACCOUNT_ID naming the Cloudflare account that runs Workers AI. Set it in the environment before running the sweep.",
	);
}
const API_TOKEN = process.env.CF_WORKERS_AI_TOKEN?.trim();

// ─── Org fixture (mirrors the live tedix org shape) ──────────────────────────

function card(input: {
	tediId: string;
	slug: string;
	name: string;
	apps: string[];
	skills?: string[];
	embodied?: boolean;
}): TediCapabilityCard {
	return {
		tediId: input.tediId,
		slug: input.slug,
		name: input.name,
		apps: input.apps,
		scopeGroups: ["tools:call", "memory:write"],
		skills: input.skills ?? [],
		runtimeKind: "agent",
		embodied: input.embodied ?? false,
		availability: "running",
		hasWarmWorkstationLease: input.embodied ?? false,
		hasRepository: input.embodied ?? false,
		depsReady: input.embodied ?? false,
		environmentReady: input.embodied ?? false,
		requiresApproval: false,
		dispatchPolicy: null,
		mcpCapabilityProfile: null,
	};
}

const FIXTURE_CONTEXT: KernelContext = {
	tedis: [
		{
			id: "tedi-cto",
			slug: "cto",
			name: "CTO",
			role: "platform engineering, code, deploys, tedi policy, skills",
			capability: card({
				tediId: "tedi-cto",
				slug: "cto",
				name: "CTO",
				apps: ["github", "cloudflare", "tedix"],
				skills: ["skill-lifecycle-management", "deploy-worker"],
				embodied: true,
			}),
		},
		{
			id: "tedi-cfo",
			slug: "cfo",
			name: "CFO",
			role: "finance, invoices, accounting",
			capability: card({
				tediId: "tedi-cfo",
				slug: "cfo",
				name: "CFO",
				apps: ["globex"],
			}),
		},
		{
			id: "tedi-ceo",
			slug: "ceo",
			name: "CEO",
			role: "communications, email, calendar",
			capability: card({
				tediId: "tedi-ceo",
				slug: "ceo",
				name: "CEO",
				apps: ["google-gmail", "google-calendar"],
			}),
		},
	],
	apps: [
		{ slug: "github", name: "GitHub" },
		{ slug: "globex", name: "Globex" },
		{ slug: "google-gmail", name: "Gmail" },
		{ slug: "google-calendar", name: "Google Calendar" },
		{ slug: "cloudflare", name: "Cloudflare" },
		{ slug: "tedix", name: "Tedix Platform" },
	],
	workflows: [
		// The live keyword-bait workflow: "help me build a workflow" must NOT match it.
		{ slug: "kernel-goal-loop-eff", title: "Kernel Goal Loop Efficiency" },
		{ slug: "weekly-report", title: "Weekly Report" },
		{ slug: "blog-citation-tracking", title: "Blog Citation Tracking" },
	],
	workItems: [],
	facts: [{ text: "Dana is the founder of Umbrella.", confidence: 0.9 }],
	rationale: [],
	speaker: {
		role: "owner",
		email: "owner@acme.example",
		approvalAuthority: true,
	},
	history: [],
};

// ─── Scenarios ───────────────────────────────────────────────────────────────

type Decision = z.infer<typeof KernelRouteDecisionSchema>;

interface Scenario {
	id: string;
	content: string;
	history?: Array<{ role: "user" | "assistant"; content: string }>;
	/** Accepted routeKinds. */
	expectRoutes: string[];
	/** Pinned delegation target (targetTediId), when applicable. */
	expectTarget?: string;
	/** Extra check over the validated decision. */
	check?: (decision: Decision) => boolean;
	/** Regression trap from a live failure — reported separately. */
	trap?: boolean;
}

const SCENARIOS: Scenario[] = [
	{
		id: "answer.basic",
		content: "what can you help me with here?",
		expectRoutes: ["answer_in_home"],
	},
	{
		id: "trap.workflow_authoring",
		content: "help me build a workflow",
		expectRoutes: ["answer_in_home", "delegate_tedi"],
		// Also a placeholder trap: the model can copy a
		// "<the specific tedi's name>" placeholder verbatim from a prompt
		// example into the operator-facing answer.
		check: (d) =>
			d.routeKind !== "run_workflow" &&
			!/[<{][a-z][^>}]*[>}]/i.test(d.answer ?? ""),
		trap: true,
	},
	{
		id: "trap.workflow_listing",
		content: "what workflows do we have?",
		expectRoutes: ["answer_in_home"],
		check: (d) => d.routeKind !== "run_workflow",
		trap: true,
	},
	{
		id: "run_workflow.exact",
		content: "run the weekly-report workflow",
		expectRoutes: ["run_workflow"],
		check: (d) => d.workflowHint === "weekly-report",
	},
	{
		id: "delegate.github_read",
		content: "give me the 5 most recent commits on our main repo",
		expectRoutes: ["delegate_tedi"],
		expectTarget: "tedi-cto",
	},
	{
		id: "delegate.invoices",
		content: "list my globex invoices from June",
		expectRoutes: ["delegate_tedi"],
		expectTarget: "tedi-cfo",
	},
	{
		id: "delegate.email_send",
		content:
			"send an email to dana@umbrella.example thanking her for the workshop",
		expectRoutes: ["delegate_tedi", "propose_tool_write"],
		check: (d) =>
			d.routeKind !== "delegate_tedi" || d.targetTediId === "tedi-ceo",
	},
	{
		id: "ask_human.ambiguous",
		content: "fix it",
		expectRoutes: ["ask_human"],
	},
	{
		id: "delegate.policy_write",
		content: "make our tedis autonomous",
		expectRoutes: ["delegate_tedi"],
		expectTarget: "tedi-cto",
	},
	{
		id: "handoff.pairing",
		content:
			"I want an hour-long pairing session with the CTO to work through the codebase together",
		expectRoutes: ["suggest_handoff"],
		expectTarget: "tedi-cto",
	},
	{
		id: "trap.verify_question",
		content: "is the weekly globex invoice summary actually set up now?",
		history: [
			{ role: "user", content: "set up a weekly globex invoice summary" },
			{
				role: "assistant",
				content:
					"The CFO reported: 'Confirmed. I'll create a weekly Monday cron job. Setting it up now.'",
			},
		],
		// History records what was SAID, not what is TRUE: verify via delegation,
		// or answer WITHOUT asserting completion as fact.
		expectRoutes: ["delegate_tedi", "answer_in_home", "ask_human"],
		check: (d) => {
			if (d.routeKind === "delegate_tedi") return true;
			const text =
				`${d.answer ?? ""} ${d.clarifyingQuestion ?? ""}`.toLowerCase();
			const asserts =
				/\b(?:yes\b|it(?:'s| is) (?:now )?(?:set up|scheduled|live|active|running))/.test(
					text,
				);
			const hedges =
				/\b(?:reported|claimed|haven't verified|not (?:yet )?verified|can(?:'t| ?not) confirm|verify|check)\b/.test(
					text,
				);
			return !asserts || hedges;
		},
		trap: true,
	},
	{
		id: "trap.depth_followup",
		content: "which mcp tools exactly? read the skill",
		history: [
			{
				role: "user",
				content: "what does the marketplace weekly winners workflow do?",
			},
			{
				role: "assistant",
				content:
					"The marketplace weekly winners workflow uses the active skill weekly-winners-to-content-opportunities to analyze Germany weekly winners, typically centered on 10 green/up winner items from marketplace data.",
			},
		],
		// DEPTH rule: the assembled context only holds one-line summaries. A
		// follow-up asking for the skill's exact tools must escalate — delegate
		// the read to the owning tedi, or answer with explicit limits — never
		// re-serve the same summary (stubborn-loop failure).
		expectRoutes: ["delegate_tedi", "answer_in_home", "ask_human"],
		check: (d) => {
			if (d.routeKind === "delegate_tedi") return true;
			const text =
				`${d.answer ?? ""} ${d.clarifyingQuestion ?? ""}`.toLowerCase();
			const parrots = text.includes("green/up winner");
			const offers =
				/\b(?:read|pull|fetch|look up|have the|want me|only (?:hold|have)|don'?t have|can'?t|cannot)\b/.test(
					text,
				);
			return !parrots && offers;
		},
		trap: true,
	},
	{
		id: "history.recall",
		content: "what is our codename?",
		history: [
			{ role: "user", content: "our project codename is BLUEFIN" },
			{ role: "assistant", content: "Noted — codename BLUEFIN." },
		],
		expectRoutes: ["answer_in_home"],
		check: (d) => (d.answer ?? "").toUpperCase().includes("BLUEFIN"),
	},
	{
		id: "delegate.embodied_coding",
		content:
			"clone the tedix repo and run the full test suite, report failures",
		expectRoutes: ["delegate_tedi"],
		expectTarget: "tedi-cto",
		check: (d) => d.effortClass === "embodied",
	},
	{
		id: "answer.fact",
		content: "who founded Umbrella?",
		expectRoutes: ["answer_in_home"],
		check: (d) => (d.answer ?? "").toLowerCase().includes("dana"),
	},
];

// ─── Production-parity parsing pipeline ──────────────────────────────────────

function parseDecision(raw: string): Decision | null {
	const cleaned = raw
		.replace(/^```(?:json)?\s*/i, "")
		.replace(/\s*```$/i, "")
		.trim();
	const start = cleaned.indexOf("{");
	const end = cleaned.lastIndexOf("}");
	const candidate =
		start >= 0 && end > start ? cleaned.slice(start, end + 1) : cleaned;
	let obj: unknown;
	try {
		obj = JSON.parse(candidate);
	} catch {
		return null;
	}
	const parsed = KernelRouteDecisionSchema.safeParse(
		normalizeRouteDecisionCandidate(obj),
	);
	return parsed.success ? parsed.data : null;
}

// ─── Runner ──────────────────────────────────────────────────────────────────

interface AttemptResult {
	scenarioId: string;
	trap: boolean;
	schemaOk: boolean;
	routeOk: boolean;
	targetOk: boolean | null;
	checkOk: boolean | null;
	routeKind: string | null;
	latencyMs: number;
	outputTokens: number | null;
}

type SweepCursor = {
	modelIndex: number;
	scenarioIndex: number;
	attemptIndex: number;
};

function argumentValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

function parsePositiveInteger(
	raw: string | undefined,
	fallback: number,
): number {
	if (!raw) return fallback;
	const value = Number(raw);
	return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function parseCursor(raw: string | undefined): SweepCursor {
	if (!raw) return { modelIndex: 0, scenarioIndex: 0, attemptIndex: 0 };
	const values = raw.split(":").map(Number);
	if (
		values.length !== 3 ||
		values.some((value) => !Number.isSafeInteger(value) || value < 0)
	) {
		throw new Error(
			`Invalid --cursor ${JSON.stringify(raw)}; expected model:scenario:attempt`,
		);
	}
	return {
		modelIndex: values[0]!,
		scenarioIndex: values[1]!,
		attemptIndex: values[2]!,
	};
}

function cursorText(cursor: SweepCursor | null): string | null {
	return cursor
		? `${cursor.modelIndex}:${cursor.scenarioIndex}:${cursor.attemptIndex}`
		: null;
}

async function runAttempt(
	model: string,
	scenario: Scenario,
	jsonSchema: unknown,
	timeoutMs: number,
): Promise<AttemptResult> {
	const context: KernelContext = {
		...FIXTURE_CONTEXT,
		history: (scenario.history ?? []) as KernelContext["history"],
	};
	const body = {
		model,
		messages: [
			{
				role: "system",
				content: `${SYSTEM_PROMPT}\n\nRespond with ONLY a single JSON object (no prose, no markdown fences) conforming to this JSON Schema:\n${JSON.stringify(jsonSchema)}`,
			},
			{ role: "user", content: buildUserPrompt(scenario.content, context) },
		],
		response_format: { type: "json_object" },
		max_tokens: MAX_OUTPUT_TOKENS,
	};
	const started = Date.now();
	let raw = "";
	let outputTokens: number | null = null;
	try {
		const response = await fetch(
			`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai/v1/chat/completions`,
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${API_TOKEN}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(timeoutMs),
			},
		);
		const latencyMs = Date.now() - started;
		if (!response.ok) {
			const detail = await response.text().catch(() => "");
			console.error(
				`    ${scenario.id}: HTTP ${response.status} ${detail.slice(0, 120)}`,
			);
			return {
				scenarioId: scenario.id,
				trap: scenario.trap ?? false,
				schemaOk: false,
				routeOk: false,
				targetOk: scenario.expectTarget ? false : null,
				checkOk: scenario.check ? false : null,
				routeKind: null,
				latencyMs,
				outputTokens: null,
			};
		}
		const data = (await response.json()) as {
			choices?: Array<{ message?: { content?: string | null } }>;
			usage?: { completion_tokens?: number };
		};
		raw = data.choices?.[0]?.message?.content ?? "";
		outputTokens = data.usage?.completion_tokens ?? null;
		const decision = parseDecision(raw);
		const schemaOk = decision !== null;
		const routeOk =
			schemaOk && scenario.expectRoutes.includes(decision.routeKind ?? "");
		const targetOk = scenario.expectTarget
			? schemaOk && decision.targetTediId === scenario.expectTarget
			: null;
		const checkOk = scenario.check
			? schemaOk && scenario.check(decision)
			: null;
		return {
			scenarioId: scenario.id,
			trap: scenario.trap ?? false,
			schemaOk,
			routeOk,
			targetOk,
			checkOk,
			routeKind: decision?.routeKind ?? null,
			latencyMs,
			outputTokens,
		};
	} catch (error) {
		return {
			scenarioId: scenario.id,
			trap: scenario.trap ?? false,
			schemaOk: false,
			routeOk: false,
			targetOk: scenario.expectTarget ? false : null,
			checkOk: scenario.check ? false : null,
			routeKind: `error:${error instanceof Error ? error.name : "unknown"}`,
			latencyMs: Date.now() - started,
			outputTokens,
		};
	}
}

function pct(n: number, d: number): string {
	return d === 0 ? "—" : `${Math.round((n / d) * 100)}%`;
}

async function main() {
	if (!API_TOKEN) {
		console.error("CF_WORKERS_AI_TOKEN missing — set it in the environment.");
		process.exit(1);
	}
	const jsonSchema = z.toJSONSchema(KernelRouteDecisionSchema);
	const summary: Array<Record<string, string | number>> = [];
	const failures: string[] = [];
	const resultsByModel = new Map<string, AttemptResult[]>();
	const json = process.argv.includes("--json");
	const totalBudgetMs = parsePositiveInteger(
		argumentValue("--max-total-ms"),
		DEFAULT_TOTAL_BUDGET_MS,
	);
	const startedAt = Date.now();
	let cursor = parseCursor(argumentValue("--cursor"));
	let complete = true;
	const report = (line: string) => {
		if (!json) console.log(line);
	};

	for (
		let modelIndex = cursor.modelIndex;
		modelIndex < CANDIDATE_MODELS.length;
		modelIndex++
	) {
		const model = CANDIDATE_MODELS[modelIndex]!;
		report(`\n── ${model} ──`);
		const results = resultsByModel.get(model) ?? [];
		resultsByModel.set(model, results);
		for (
			let scenarioIndex =
				modelIndex === cursor.modelIndex ? cursor.scenarioIndex : 0;
			scenarioIndex < SCENARIOS.length;
			scenarioIndex++
		) {
			const scenario = SCENARIOS[scenarioIndex]!;
			for (
				let attempt =
					modelIndex === cursor.modelIndex &&
					scenarioIndex === cursor.scenarioIndex
						? cursor.attemptIndex
						: 0;
				attempt < ATTEMPTS_PER_SCENARIO;
				attempt++
			) {
				const remainingMs = totalBudgetMs - (Date.now() - startedAt);
				if (remainingMs <= 0) {
					complete = false;
					cursor = { modelIndex, scenarioIndex, attemptIndex: attempt };
					break;
				}
				const result = await runAttempt(
					model,
					scenario,
					jsonSchema,
					Math.min(REQUEST_TIMEOUT_MS, remainingMs),
				);
				results.push(result);
				const verdictBits = [
					result.schemaOk ? "schema✓" : "schema✗",
					result.routeOk ? "route✓" : `route✗(${result.routeKind})`,
					...(result.targetOk === null
						? []
						: [result.targetOk ? "target✓" : "target✗"]),
					...(result.checkOk === null
						? []
						: [result.checkOk ? "check✓" : "check✗"]),
				];
				report(
					`  ${scenario.id} #${attempt + 1}: ${verdictBits.join(" ")} ${result.latencyMs}ms`,
				);
				const allOk =
					result.schemaOk &&
					result.routeOk &&
					result.targetOk !== false &&
					result.checkOk !== false;
				if (!allOk) {
					failures.push(
						`${model} ${scenario.id}#${attempt + 1}: ${verdictBits.join(" ")}`,
					);
				}
			}
			if (!complete) break;
		}
		if (!complete) break;
		cursor = { modelIndex: modelIndex + 1, scenarioIndex: 0, attemptIndex: 0 };
	}

	for (const model of CANDIDATE_MODELS) {
		const results = resultsByModel.get(model) ?? [];
		if (results.length === 0) continue;
		const total = results.length;
		const schemaOk = results.filter((r) => r.schemaOk).length;
		const routeOk = results.filter((r) => r.routeOk).length;
		const targeted = results.filter((r) => r.targetOk !== null);
		const targetOk = targeted.filter((r) => r.targetOk === true).length;
		const trapResults = results.filter((r) => r.trap);
		const trapOk = trapResults.filter(
			(r) => r.schemaOk && r.routeOk && r.checkOk !== false,
		).length;
		const passAll = results.filter(
			(r) =>
				r.schemaOk && r.routeOk && r.targetOk !== false && r.checkOk !== false,
		).length;
		const meanLatency = Math.round(
			results.reduce((sum, r) => sum + r.latencyMs, 0) / total,
		);
		summary.push({
			model,
			pass: pct(passAll, total),
			schema: pct(schemaOk, total),
			route: pct(routeOk, total),
			target: pct(targetOk, targeted.length),
			traps: pct(trapOk, trapResults.length),
			meanMs: meanLatency,
		});
	}

	const scorecard = {
		v: 1,
		complete,
		elapsedMs: Date.now() - startedAt,
		totalBudgetMs,
		nextCursor: complete ? null : cursorText(cursor),
		models: summary,
		failures,
		results: [...resultsByModel.entries()].flatMap(([model, results]) =>
			results.map((result) => ({ model, ...result })),
		),
	};
	if (json) {
		console.log(JSON.stringify(scorecard));
	} else {
		console.log("\n== SWEEP SUMMARY ==");
		console.table(summary);
		if (failures.length > 0) {
			console.log("\n== FAILURES ==");
			for (const failure of failures) console.log(`  ${failure}`);
		}
		if (!complete) {
			console.log(
				`\n== BUDGET EXHAUSTED == resume with --cursor ${cursorText(cursor)}`,
			);
		}
	}
}

await main();
