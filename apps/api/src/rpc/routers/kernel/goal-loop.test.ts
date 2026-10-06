import { describe, expect, it } from "vite-plus/test";
import {
	type GoalLoopPorts,
	type GoalLoopSettledTurn,
	judgeGoalCondition as actualJudge,
	runGoalLoop,
} from "./goal-loop";

function pricing(cost: number | null) {
	return {
		knownSubtotalUsd: cost ?? 0,
		attemptCount: 1,
		pricedAttemptCount: cost === null ? 0 : 1,
		costCompleteness:
			cost === null ? ("unknown" as const) : ("complete" as const),
		reason: cost === null ? "missing_usage" : null,
		executionId: "receipt",
		rateVersionId: "rate",
	};
}
function judgeGoalCondition(args: {
	condition: string;
	answer: string;
	noul?: number | null;
	admitted?: boolean;
	throw?: boolean;
}) {
	return actualJudge({
		condition: args.condition,
		answer: args.answer,
		db: {} as never,
		env: { TEDIX_FLEET_AUTHORITY_MODE: "co-located", DB: {} } as never,
		context: { organizationId: "org-test" },
		judge: (async (request: {
			onExecutionAttempts?: (attempts: unknown[]) => void;
		}) => {
			if (args.throw) throw new Error("provider unavailable");
			if (args.admitted !== false)
				request.onExecutionAttempts?.([
					{ executionId: "jev-execution-test", usage: {} },
				]);
			return args.noul === null
				? null
				: { answers: { met: { type: "noul", noul: args.noul ?? 0 } } };
		}) as never,
		price: async () => ({ costUsd: 0.002, pricing: pricing(0.002) }),
	});
}

function settled(
	overrides: Partial<GoalLoopSettledTurn> = {},
): GoalLoopSettledTurn {
	return {
		pricing: pricing(
			overrides.costUsd === undefined ? 0.01 : overrides.costUsd,
		),
		runId: "run-1",
		status: "completed",
		routeKind: "answer_in_home",
		costUsd: 0.01,
		answer: "Loop engineering is about feedback loops.",
		...overrides,
	};
}

/** A ports.runTurn that returns a scripted sequence of settled turns. */
function scriptedPorts(
	turns: GoalLoopSettledTurn[],
	judge?: GoalLoopPorts["judge"],
): GoalLoopPorts {
	let i = 0;
	return {
		runTurn: async () => turns[Math.min(i++, turns.length - 1)],
		judge: judge
			? async (input) => {
					const result = await judge(input);
					return { ...result, pricing: pricing(result.costUsd) };
				}
			: undefined,
	};
}

describe("runGoalLoop — ceilings + separate-evaluator", () => {
	it("deterministic: stops condition_met when the answer matches the regex (turn 1)", async () => {
		const r = await runGoalLoop(
			{ content: "define loop engineering", condition: "loop", maxTurns: 3 },
			scriptedPorts([settled()]),
		);
		expect(r.met).toBe(true);
		expect(r.stop).toBe("condition_met");
		expect(r.turns).toBe(1);
		expect(r.evidence[0]?.verdict).toBe("done");
		expect(r.totalCostUsd).toBeCloseTo(0.01, 6);
	});

	it("stops on stall after >2 non-matching turns", async () => {
		const r = await runGoalLoop(
			{ content: "x", condition: "WONTMATCH", maxTurns: 6 },
			scriptedPorts([settled(), settled(), settled(), settled()]),
		);
		expect(r.met).toBe(false);
		expect(r.stop).toBe("stall");
		expect(r.turns).toBe(3); // stall increments to 3 on turn 3 → >2 → stop
	});

	it("stops on max_turns when the cap is reached before stall fires", async () => {
		const r = await runGoalLoop(
			{ content: "x", condition: "WONTMATCH", maxTurns: 2 },
			scriptedPorts([settled(), settled()]),
		);
		expect(r.met).toBe(false);
		expect(r.stop).toBe("max_turns");
		expect(r.turns).toBe(2);
	});

	it("enforces the budgetUsd ceiling (summed per-turn cost)", async () => {
		const r = await runGoalLoop(
			{ content: "x", condition: "WONTMATCH", maxTurns: 5, budgetUsd: 0.025 },
			scriptedPorts([
				settled({ costUsd: 0.02 }),
				settled({ costUsd: 0.02 }), // cumulative 0.04 > 0.025
				settled({ costUsd: 0.02 }),
			]),
		);
		expect(r.stop).toBe("budget_exceeded");
		expect(r.turns).toBe(2);
		expect(r.totalCostUsd).toBeCloseTo(0.04, 6);
	});

	it("adversarial: the separate judge decides done, and its cost is budgeted", async () => {
		const r = await runGoalLoop(
			{
				content: "x",
				condition: "anything",
				maxTurns: 3,
				evaluator: "adversarial",
			},
			scriptedPorts([settled({ costUsd: 0.01 })], async () => ({
				done: true,
				runId: "judge-1",
				costUsd: 0.005,
			})),
		);
		expect(r.met).toBe(true);
		expect(r.stop).toBe("condition_met");
		expect(r.evidence[0]?.judgeRunId).toBe("judge-1");
		expect(r.evidence[0]?.evaluator).toBe("adversarial");
		// maker cost + judge cost are both counted.
		expect(r.totalCostUsd).toBeCloseTo(0.015, 6);
	});

	it("adversarial without a judge port falls back to the deterministic checker", async () => {
		const r = await runGoalLoop(
			{
				content: "x",
				condition: "loop",
				maxTurns: 2,
				evaluator: "adversarial",
			},
			scriptedPorts([settled()]), // no judge → regex on the answer ("...loop...")
		);
		expect(r.met).toBe(true);
		expect(r.goal.evaluator).toBe("deterministic");
	});

	// --- Why the Workflow wrapper MUST supply a judge port -------------------
	// The two tests below pin the exact hazard of the deterministic fallback:
	// the condition is compiled as a REGEX and tested against the maker's OWN
	// answer, so a maker that merely RESTATES the goal grades itself as done.
	// KernelGoalLoopWorkflow now always wires `judge`, so an adversarial goal
	// never silently lands on this path.
	it("HAZARD: without a judge, a maker that merely RESTATES the goal is scored done", async () => {
		const r = await runGoalLoop(
			{
				content: "Fix the flaky test",
				condition: "the flaky test is fixed",
				maxTurns: 2,
				evaluator: "adversarial",
			},
			// The maker did NOT fix anything — it only echoed the goal back.
			scriptedPorts([
				settled({ answer: "I will make sure the flaky test is fixed." }),
			]),
		);
		expect(r.goal.evaluator).toBe("deterministic"); // silently downgraded
		expect(r.met).toBe(true); // ...and falsely satisfied
	});

	it("a wired judge rejects the same restate-the-goal answer (maker != checker holds)", async () => {
		const r = await runGoalLoop(
			{
				content: "Fix the flaky test",
				condition: "the flaky test is fixed",
				maxTurns: 1,
				evaluator: "adversarial",
			},
			scriptedPorts(
				[settled({ answer: "I will make sure the flaky test is fixed." })],
				async () => ({
					done: false,
					runId: null,
					costUsd: 0.002,
					pricing: pricing(0.002),
				}),
			),
		);
		expect(r.goal.evaluator).toBe("adversarial");
		expect(r.met).toBe(false);
		expect(r.stop).toBe("max_turns");
		// the judge's own cost is budgeted alongside the maker's
		expect(r.totalCostUsd).toBeCloseTo(0.012, 6);
	});

	it("clamps maxTurns to 1..8 and applies the default budget", async () => {
		const big = await runGoalLoop(
			{ content: "x", condition: "WONTMATCH", maxTurns: 999 },
			scriptedPorts([settled({ costUsd: 0 })]),
		);
		expect(big.goal.maxTurns).toBe(8);
		expect(big.goal.budgetUsd).toBe(0.1);
		const small = await runGoalLoop(
			{ content: "x", condition: "WONTMATCH", maxTurns: 0 },
			scriptedPorts([settled({ costUsd: 0 })]),
		);
		expect(small.goal.maxTurns).toBe(1);
		expect(small.stop).toBe("max_turns");
	});

	it("records per-turn evidence with cumulative spend", async () => {
		const r = await runGoalLoop(
			{ content: "x", condition: "WONTMATCH", maxTurns: 2 },
			scriptedPorts([
				settled({ costUsd: 0.01, runId: "a" }),
				settled({ costUsd: 0.02, runId: "b" }),
			]),
		);
		expect(r.evidence.map((e) => e.runId)).toEqual(["a", "b"]);
		expect(r.evidence[0]?.spentUsd).toBeCloseTo(0.01, 6);
		expect(r.evidence[1]?.spentUsd).toBeCloseTo(0.03, 6);
	});
});

describe("judgeGoalCondition — typed Jev answer judgment", () => {
	it("accepts only a confident Noul and attributes the admitted pass", async () => {
		await expect(
			judgeGoalCondition({ condition: "c", answer: "a", noul: 0.9 }),
		).resolves.toEqual({
			done: true,
			runId: null,
			costUsd: 0.002,
			pricing: pricing(0.002),
		});
		const uncertain = await judgeGoalCondition({
			condition: "c",
			answer: "a",
			noul: 0.8,
		});
		expect(uncertain.done).toBe(false);
		expect(uncertain.costUsd).toBe(0.002);
	});

	it("unavailable before admission never claims completion or a known price", async () => {
		await expect(
			judgeGoalCondition({
				condition: "c",
				answer: "a",
				noul: null,
				admitted: false,
			}),
		).resolves.toEqual({
			done: false,
			runId: null,
			costUsd: null,
			pricing: null,
		});
	});

	it("a provider failure after admission remains budgeted and fails closed", async () => {
		const result = await judgeGoalCondition({
			condition: "c",
			answer: "a",
			throw: true,
		});
		expect(result.done).toBe(false);
		expect(result.costUsd).toBeNull();
	});
});

describe("runGoalLoop — work_items evaluator", () => {
	function workItemsPorts(
		snapshots: Array<{
			total: number;
			outstandingIds: string[];
			outstandingCount?: number;
		}>,
	): GoalLoopPorts {
		let i = 0;
		return {
			runTurn: async () => settled(),
			checkWorkItems: async () => {
				const s = snapshots[Math.min(i, snapshots.length - 1)];
				i++;
				return {
					total: s.total,
					doneCount: s.total - (s.outstandingCount ?? s.outstandingIds.length),
					outstandingCount: s.outstandingCount ?? s.outstandingIds.length,
					outstandingIds: s.outstandingIds,
				};
			},
		};
	}

	it("stops condition_met once all work items under the objective are done", async () => {
		const r = await runGoalLoop(
			{
				content: "ship the feature",
				condition: "unused-for-this-evaluator",
				evaluator: "work_items",
				objectiveId: "obj-1",
				maxTurns: 4,
			},
			workItemsPorts([
				{ total: 3, outstandingIds: ["wi-2", "wi-3"] },
				{ total: 3, outstandingIds: ["wi-3"] },
				{ total: 3, outstandingIds: [] },
			]),
		);
		expect(r.met).toBe(true);
		expect(r.stop).toBe("condition_met");
		expect(r.turns).toBe(3);
		expect(r.evidence[2]?.workItems?.outstandingIds).toEqual([]);
		expect(r.goal.evaluator).toBe("work_items");
		expect(r.goal.objectiveId).toBe("obj-1");
	});

	it("uses the full outstanding count instead of a bounded ID preview", async () => {
		const r = await runGoalLoop(
			{
				content: "ship every leaf",
				condition: "unused",
				evaluator: "work_items",
				objectiveId: "obj-large",
				maxTurns: 1,
			},
			workItemsPorts([
				{ total: 700, outstandingCount: 200, outstandingIds: [] },
			]),
		);
		expect(r.met).toBe(false);
		expect(r.evidence[0]?.workItems?.outstandingCount).toBe(200);
	});

	it("does not treat zero work items as done (objective not yet decomposed)", async () => {
		// Same stall-ceiling discipline as the deterministic evaluator: 3
		// non-done turns trips the >2 stall guard before max_turns. The
		// assertion that matters is r.met === false — an empty objective must
		// never be reported as satisfied.
		const r = await runGoalLoop(
			{
				content: "ship the feature",
				condition: "unused",
				evaluator: "work_items",
				objectiveId: "obj-empty",
				maxTurns: 3,
			},
			workItemsPorts([
				{ total: 0, outstandingIds: [] },
				{ total: 0, outstandingIds: [] },
				{ total: 0, outstandingIds: [] },
			]),
		);
		expect(r.met).toBe(false);
		expect(r.stop).toBe("stall");
	});

	it("falls back to the deterministic checker when objectiveId is missing", async () => {
		const r = await runGoalLoop(
			{
				content: "define loop engineering",
				condition: "loop",
				evaluator: "work_items",
				// objectiveId omitted on purpose
				maxTurns: 3,
			},
			workItemsPorts([{ total: 5, outstandingIds: [] }]),
		);
		expect(r.goal.evaluator).toBe("deterministic");
		expect(r.met).toBe(true);
		expect(r.stop).toBe("condition_met");
	});

	it("falls back to the deterministic checker when checkWorkItems port is absent", async () => {
		const r = await runGoalLoop(
			{
				content: "define loop engineering",
				condition: "loop",
				evaluator: "work_items",
				objectiveId: "obj-1",
				maxTurns: 3,
			},
			scriptedPorts([settled()]),
		);
		expect(r.goal.evaluator).toBe("deterministic");
		expect(r.met).toBe(true);
	});

	it("respects budget_exceeded even under the work_items evaluator", async () => {
		const r = await runGoalLoop(
			{
				content: "ship the feature",
				condition: "unused",
				evaluator: "work_items",
				objectiveId: "obj-1",
				maxTurns: 8,
				budgetUsd: 0.005,
			},
			workItemsPorts([
				{ total: 2, outstandingIds: ["wi-1"] },
				{ total: 2, outstandingIds: ["wi-1"] },
			]),
		);
		expect(r.met).toBe(false);
		expect(r.stop).toBe("budget_exceeded");
	});
});
