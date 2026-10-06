import type { KernelPricingEvidence } from "@tedix/api-contract/schemas/cost-provenance";
import type { DbClient } from "@tedix/db/client";
/**
 * Kernel — first-class goal-loop primitive.
 *
 * The governed self-prompting loop (maker/checker turns under a max-turn cap),
 * as a pure, dependency-injected driver so it can be unit-tested without a Cloudflare
 * Workflow or a live kernel. Each turn:
 *   maker → submit a kernel turn and settle it to terminal (injected `runTurn`)
 *   checker → a SEPARATE evaluator decides done/continue (maker ≠ checker):
 *     - "deterministic": a regex `condition` the maker prompt never contains
 *     - "adversarial":   a SEPARATE LLM judge turn that may ONLY judge, never
 *                        answer the task (injected `judge`)
 *     - "work_items":    reads whether every leaf Work Item under `objectiveId`
 *                        has reached the PROOF-GATED `done` status (injected
 *                        `checkWorkItems`) — completion is evidenced by the
 *                        existing Work Item proof gate
 *                        (`disposeDelegationWorkItem`: `done` is reachable
 *                        ONLY with a real proof ref; a completion with no
 *                        proof is forced to `blocked`), not by re-judging the
 *                        maker's own text answer. This is the primitive for
 *                        "assign a goal, decompose it into Work Items, and
 *                        stop only when all executable leaves are provably
 *                        done" —
 *                        loop-engineering.md L5 roadmap item 4.
 *   ceilings → stop on condition_met, budget_exceeded (summed per-turn cost >
 *     budgetUsd), stall (>2), or max_turns. A goal with no ceiling cannot run —
 *     defaults apply and maxTurns is clamped.
 *
 * The Cloudflare-Workflow wrapper (KERNEL_GOAL_LOOP_WORKFLOW) injects the real
 * ports: `runTurn` = enqueue a kernel turn via createRouterClient(kernelRuntime)
 * + poll the run to terminal; `judge` = {@link judgeGoalCondition} over
 * kernelModel. This Workflow alone owns the work_items completion oracle;
 * reference skill/MCP harnesses do not duplicate that snapshot logic.
 */

import { priceKernelUsage } from "../../../services/provider-model-pricing";
import type { FleetAuthorityEnv } from "../../../lib/fleet-authority";
import { executeJevJudgment } from "../../../services/jev-judgment";
import type { JevEnv } from "@tedix/workers-ai/jev";
import type {
	KernelExecutionAttempt,
	KernelGatewayContext,
} from "./gateway-attribution";
import type { KernelWorkersAiEnv } from "./workers-ai-client";
import {
	buildGoalAnswerQuestion,
	interpretGoalAnswer,
} from "./jev-goal-assessment";

export type GoalLoopEvaluator = "deterministic" | "adversarial" | "work_items";

/** Work Item completion snapshot under one objective (the `work_items` checker). */
export interface GoalLoopWorkItemsSnapshot {
	total: number;
	doneCount: number;
	/** Full count of leaves NOT in the proof-gated `done` status. */
	outstandingCount: number;
	/** Bounded operator-facing preview; never use its length as the verdict. */
	outstandingIds: string[];
}

/** A kernel turn settled to a terminal status (the maker result). */
export interface GoalLoopSettledTurn {
	runId: string | null;
	/** "completed" | "failed" | "requires_approval" | "unsettled". */
	status: string;
	routeKind: string | null;
	/** This turn's model cost (bodyExecutionResult.cost.totalCostUsd), 0 if absent. */
	costUsd: number | null;
	pricing: KernelPricingEvidence | null;
	/** The operator-facing answer the checker evaluates. */
	answer: string;
}

/** Injected side effects — the only impure surface. Mocked in tests. */
export interface GoalLoopPorts {
	/** Submit one kernel turn with `content` and resolve it to terminal. */
	runTurn: (content: string) => Promise<GoalLoopSettledTurn>;
	/**
	 * Adversarial LLM judge (used only when evaluator === "adversarial"). Returns
	 * whether the answer satisfies the condition, plus the judge turn's id/cost so
	 * the loop can attribute and budget it. Optional — absent ⇒ the loop falls back
	 * to the deterministic checker.
	 */
	judge?: (args: { condition: string; answer: string }) => Promise<{
		done: boolean;
		runId: string | null;
		costUsd: number | null;
		pricing: KernelPricingEvidence | null;
	}>;
	/**
	 * Work-Item completion reader (used only when evaluator === "work_items").
	 * Reads the canonical leaf-work snapshot under `objectiveId`. Optional — absent ⇒
	 * the loop falls back to the deterministic checker, same discipline as
	 * `judge`.
	 */
	checkWorkItems?: (objectiveId: string) => Promise<GoalLoopWorkItemsSnapshot>;
}

export interface GoalLoopParams {
	content: string;
	condition: string;
	/** Default 3, clamped to 1..8. */
	maxTurns?: number;
	/** Cumulative model-cost ceiling in USD. Default 0.10. */
	budgetUsd?: number;
	/** Default "deterministic". */
	evaluator?: GoalLoopEvaluator;
	/** Required for evaluator === "work_items" — the objective whose Work Items gate completion. */
	objectiveId?: string;
}

export interface GoalLoopTurnEvidence {
	turn: number;
	runId: string | null;
	status: string;
	routeKind: string | null;
	costUsd: number | null;
	pricing: KernelPricingEvidence | null;
	evaluator: GoalLoopEvaluator;
	verdict: "done" | "continue";
	judgeRunId: string | null;
	judgeCostUsd: number | null;
	/** Set only when evaluator === "work_items" — the checked snapshot for this turn. */
	workItems: GoalLoopWorkItemsSnapshot | null;
	spentUsd: number;
	answer: string;
}

export type GoalLoopStop =
	| "condition_met"
	| "budget_exceeded"
	| "stall"
	| "max_turns"
	| "pricing_unavailable";

export interface GoalLoopResult {
	goal: {
		content: string;
		condition: string;
		maxTurns: number;
		budgetUsd: number;
		evaluator: GoalLoopEvaluator;
		objectiveId: string | null;
	};
	met: boolean;
	stop: GoalLoopStop;
	turns: number;
	totalCostUsd: number | null;
	knownSubtotalUsd: number;
	costCompleteness: "complete" | "partial" | "unknown";
	evidence: GoalLoopTurnEvidence[];
}

const MAX_GOAL_TURNS = 8;
const DEFAULT_MAX_TURNS = 3;
const DEFAULT_BUDGET_USD = 0.1;

/**
 * Drive the governed goal loop. Pure over the injected {@link GoalLoopPorts}:
 * deterministic given the same `runTurn`/`judge` results, with enforced ceilings
 * (maxTurns, stall > 2, budgetUsd). The checker never shares the maker's prompt.
 */
export async function runGoalLoop(
	params: GoalLoopParams,
	ports: GoalLoopPorts,
): Promise<GoalLoopResult> {
	const maxTurns = Math.max(
		1,
		Math.min(Math.trunc(params.maxTurns ?? DEFAULT_MAX_TURNS), MAX_GOAL_TURNS),
	);
	const budgetUsd =
		typeof params.budgetUsd === "number" && params.budgetUsd > 0
			? params.budgetUsd
			: DEFAULT_BUDGET_USD;
	const evaluator: GoalLoopEvaluator =
		params.evaluator === "work_items" &&
		ports.checkWorkItems &&
		params.objectiveId
			? "work_items"
			: params.evaluator === "adversarial" && ports.judge
				? "adversarial"
				: "deterministic";
	// The deterministic checker the maker prompt never contains (maker != checker).
	const re = new RegExp(params.condition, "i");

	const evidence: GoalLoopTurnEvidence[] = [];
	let met = false;
	let stop: GoalLoopStop = "max_turns";
	let stall = 0;
	let spent = 0;

	for (let turn = 1; turn <= maxTurns; turn++) {
		const settled = await ports.runTurn(params.content); // MAKER
		if (
			!(
				settled.pricing &&
				["complete", "no_usage"].includes(settled.pricing.costCompleteness)
			) ||
			settled.costUsd === null ||
			!Number.isFinite(settled.costUsd) ||
			settled.costUsd < 0
		) {
			spent += settled.pricing?.knownSubtotalUsd ?? 0;
			evidence.push({
				pricing: settled.pricing,
				turn,
				runId: settled.runId,
				status: settled.status,
				routeKind: settled.routeKind,
				costUsd: null,
				evaluator,
				verdict: "continue",
				judgeRunId: null,
				judgeCostUsd: null,
				workItems: null,
				spentUsd: spent,
				answer: settled.answer.slice(0, 240),
			});
			stop = "pricing_unavailable";
			break;
		}
		spent += settled.costUsd;

		let verdict: "done" | "continue";
		let judgeRunId: string | null = null;
		let judgeCostUsd: number | null = null;
		let workItemsSnapshot: GoalLoopWorkItemsSnapshot | null = null;
		if (
			evaluator === "work_items" &&
			ports.checkWorkItems &&
			params.objectiveId
		) {
			workItemsSnapshot = await ports.checkWorkItems(params.objectiveId);
			verdict =
				workItemsSnapshot.total > 0 && workItemsSnapshot.outstandingCount === 0
					? "done"
					: "continue";
		} else if (evaluator === "adversarial" && ports.judge) {
			const j = await ports.judge({
				condition: params.condition,
				answer: settled.answer,
			});
			judgeRunId = j.runId;
			judgeCostUsd = j.costUsd;
			if (
				!(
					j.pricing &&
					["complete", "no_usage"].includes(j.pricing.costCompleteness)
				) ||
				j.costUsd === null ||
				!Number.isFinite(j.costUsd) ||
				j.costUsd < 0
			) {
				stop = "pricing_unavailable";
				spent += j.pricing?.knownSubtotalUsd ?? 0;
			} else spent += j.costUsd;
			verdict = j.done ? "done" : "continue";
		} else {
			verdict = re.test(settled.answer) ? "done" : "continue";
		}

		evidence.push({
			turn,
			runId: settled.runId,
			status: settled.status,
			routeKind: settled.routeKind,
			costUsd: settled.costUsd,
			pricing: settled.pricing,
			evaluator,
			verdict,
			judgeRunId,
			judgeCostUsd,
			workItems: workItemsSnapshot,
			spentUsd: Number(spent.toFixed(6)),
			answer: settled.answer.slice(0, 240),
		});

		if (stop === "pricing_unavailable") break;
		if (verdict === "done") {
			met = true;
			stop = "condition_met";
			break;
		}
		if (spent > budgetUsd) {
			stop = "budget_exceeded";
			break;
		}
		stall += 1;
		if (stall > 2) {
			stop = "stall";
			break;
		}
	}

	return {
		goal: {
			content: params.content,
			condition: params.condition,
			maxTurns,
			budgetUsd,
			evaluator,
			objectiveId: params.objectiveId ?? null,
		},
		met,
		stop,
		turns: evidence.length,
		totalCostUsd:
			stop === "pricing_unavailable" ? null : Number(spent.toFixed(6)),
		knownSubtotalUsd: Number(spent.toFixed(6)),
		costCompleteness:
			stop === "pricing_unavailable"
				? evidence.some(
						(row) => row.pricing && row.pricing.pricedAttemptCount > 0,
					)
					? "partial"
					: "unknown"
				: "complete",
		evidence,
	};
}

/**
 * Separate typed Jev evaluator for semantic goal conditions. Jev can assess
 * answer coverage, but cannot establish external completion; use the Work Item
 * oracle for that. A missing/unavailable judgment never claims success.
 *
 * Billing admission and durable provider receipt belong to the shared Jev
 * executor. We also price the captured attempt for this loop's own budget;
 * this is cost attribution, not a second charge. No kernel run is minted.
 */
export async function judgeGoalCondition(args: {
	condition: string;
	answer: string;
	db: DbClient;
	env: FleetAuthorityEnv & KernelWorkersAiEnv & JevEnv;
	context: KernelGatewayContext;
	timeoutMs?: number;
	judge?: typeof executeJevJudgment;
	price?: typeof priceKernelUsage;
}): Promise<{
	done: boolean;
	runId: string | null;
	costUsd: number | null;
	pricing: KernelPricingEvidence | null;
}> {
	const request = buildGoalAnswerQuestion(args);
	if (!request || !args.context.organizationId)
		return { done: false, runId: null, costUsd: null, pricing: null };
	const attempts: KernelExecutionAttempt[] = [];
	let done = false;
	try {
		const result = await (args.judge ?? executeJevJudgment)({
			db: args.db,
			env: args.env,
			context: args.context,
			...request,
			source: "kernel:goal-judge",
			billingSource: "kernel",
			sessionType: "kernel",
			timeoutMs: args.timeoutMs ?? 5000,
			onExecutionAttempts: (captured) => attempts.push(...captured),
		});
		done = interpretGoalAnswer(result?.answers.met);
	} catch {
		// Captured paid attempts still count toward the goal's budget.
	}
	if (!attempts.length)
		return { done: false, runId: null, costUsd: null, pricing: null };
	const priced = await (args.price ?? priceKernelUsage)(args.env, { attempts });
	return { done, runId: null, ...priced };
}
