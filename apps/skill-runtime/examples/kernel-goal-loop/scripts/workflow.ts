/**
 * kernel-goal-loop — durable L2 goal-loop skill workflow.
 *
 * Runs the loop-engineering governed goal-loop as a Cloudflare Workflow: each
 * kernel turn (home.ask), each poll (home.read_home_run_set), and each
 * inter-turn wait (step.sleep) is a durable checkpoint, so the loop survives DO
 * hibernation and is replayable from the step timeline.
 *
 * The kernel is driven through the skill-runtime MCP bridge: env.MCP.home.* are
 * the same home__* tools the operator gateway exposes, scoped to the running
 * tedi as the speaker. Only small extracted fields are returned from each
 * step.do — the large run-set payload is consumed inside the step and never
 * persisted (avoids the large-step-value stall: a full run-set persisted as a
 * step value stalls the workflow, so only extracted fields ever leave a step).
 *
 * Separate-evaluator stop-check (maker != checker):
 *  - "deterministic": a regex `condition` the maker prompt never contains.
 *  - "adversarial":   a second ask judge turn that may only rule
 *                     DONE/CONTINUE and is forbidden from answering the task.
 *
 * The work_items evaluator lives only in the first-class
 * KERNEL_GOAL_LOOP_WORKFLOW, whose single D1 statement is the canonical
 * completion oracle. This reference skill rejects that mode rather than
 * duplicating snapshot semantics through paginated MCP reads.
 *
 * Enforced ceilings: maxTurns, stall>2, and budgetUsd (summed bodyExecutionResult
 * cost). A goal with no ceiling cannot run — defaults apply.
 *
 * params: { content, condition, maxTurns?, budgetUsd?, evaluator?,
 *           pollAttempts?, sleepSeconds? }
 */

export default {
	async run(event, step, env) {
		const p = event.payload ?? {};
		const content = p.content;
		const condition = p.condition;
		if (!content || !condition) {
			throw new Error(
				"kernel-goal-loop requires params.content and params.condition",
			);
		}
		const maxTurns = Math.max(1, Math.min(Number(p.maxTurns ?? 3), 8));
		const budgetUsd = Number(p.budgetUsd ?? 0.1);
		if (p.evaluator === "work_items") {
			throw new Error(
				"kernel-goal-loop skill no longer duplicates the work_items oracle; use the first-class kernel goal-loop Workflow (tedix goal --evaluator work_items)",
			);
		}
		const objectiveId = null;
		const evaluator =
			p.evaluator === "adversarial" ? "adversarial" : "deterministic";
		const pollAttempts = Math.max(
			1,
			Math.min(Number(p.pollAttempts ?? 18), 40),
		);
		const sleepSeconds = Math.max(1, Math.min(Number(p.sleepSeconds ?? 3), 30));
		const re = new RegExp(condition, "i");

		const evidence = [];
		let met = false;
		let stop = "max_turns";
		let stall = 0;
		let spent = 0;

		// Submit one kernel turn and poll it to terminal, returning only small fields.
		const askAndSettle = async (label, text) => {
			const submit = await step.do(
				`ask-${label}`,
				{ timeout: "30 seconds" },
				async () => {
					const r = await env.MCP.home.ask({ content: text });
					// The skill-runtime MCP bridge's raw ask response is FLAT
					// ({ homeRunId, runStatus, kernelRoute, ... }) — not the { run: {...} }
					// shape the codemode gateway surfaces for the same tool call.
					// Confirmed live via debug instrumentation (raw JSON dump of a real
					// response). Check both conventions so this self-heals if either
					// surface's shape shifts again.
					return {
						runId:
							r?.homeRunId ??
							r?.run?.id ??
							r?.task?.id ??
							r?.idempotencyKey ??
							null,
					};
				},
			);
			const runId = submit.runId;
			let settled = null;
			for (let i = 0; i < pollAttempts && !settled; i++) {
				const snap = await step.do(
					`poll-${label}-${i}`,
					{ timeout: "20 seconds" },
					async () => {
						// Single-run read (O(1)) — never the full conversation run-set, which
						// is O(all runs) and stalls the poll step on a busy conversation.
						const res = await env.MCP.home.read_home_run({ runId });
						// Same flat-vs-nested shape uncertainty as ask above — check both.
						const status = res?.runStatus ?? res?.run?.status ?? null;
						if (
							!status ||
							!["completed", "failed", "requires_approval"].includes(status)
						) {
							return { done: false };
						}
						const route =
							res?.kernelRoute ?? res?.run?.metadata?.kernelRoute ?? {};
						const body =
							res?.bodyExecutionResult ??
							res?.run?.metadata?.bodyExecutionResult ??
							{};
						return {
							done: true,
							status,
							routeKind: route.routeKind ?? null,
							effortClass: route.effortClass ?? null,
							routerVersion:
								route.routerVersion ??
								res?.routerVersion ??
								res?.run?.metadata?.routerVersion ??
								null,
							harnessVersionId:
								res?.harnessVersionId ??
								res?.run?.metadata?.harnessVersionId ??
								null,
							traceBundleId: body?.traceBundleId ?? null,
							costUsd: body?.cost?.totalCostUsd ?? 0,
							answer: String(route.answer ?? body.summary ?? "").slice(0, 240),
						};
					},
				);
				if (snap.done) {
					settled = snap;
				} else if (i < pollAttempts - 1) {
					await step.sleep(`wait-${label}-${i}`, `${sleepSeconds} seconds`);
				}
			}
			return { runId, settled };
		};

		for (let turn = 1; turn <= maxTurns; turn++) {
			const maker = await askAndSettle(`t${turn}`, content);
			const s = maker.settled;
			spent += s?.costUsd ?? 0;

			let verdict = "continue";
			let judgeRunId = null;
			let judgeCostUsd = null;
			const workItems = null;
			if (evaluator === "adversarial") {
				const judge = await askAndSettle(
					`judge${turn}`,
					`You are an adversarial validator. Do NOT answer any question or perform any task. ` +
						`Judge ONLY whether the following ANSWER genuinely satisfies the CONDITION: "${condition}". ` +
						`Reply with EXACTLY one word: DONE if it does, otherwise CONTINUE.\nANSWER: ${s?.answer ?? ""}`,
				);
				judgeRunId = judge.settled ? judge.runId : null;
				judgeCostUsd = judge.settled?.costUsd ?? null;
				spent += judge.settled?.costUsd ?? 0;
				verdict = /\bDONE\b/i.test(judge.settled?.answer ?? "")
					? "done"
					: "continue";
			} else {
				verdict = re.test(s?.answer ?? "") ? "done" : "continue";
			}

			evidence.push({
				turn,
				runId: maker.runId,
				status: s?.status ?? "unsettled",
				routeKind: s?.routeKind ?? null,
				effortClass: s?.effortClass ?? null,
				routerVersion: s?.routerVersion ?? null,
				harnessVersionId: s?.harnessVersionId ?? null,
				traceBundleId: s?.traceBundleId ?? null,
				costUsd: s?.costUsd ?? 0,
				evaluator,
				verdict,
				judgeRunId,
				judgeCostUsd,
				workItems,
				spentUsd: Number(spent.toFixed(6)),
				answer: s?.answer ?? "",
			});

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
			goal: { content, condition, maxTurns, budgetUsd, evaluator, objectiveId },
			met,
			stop,
			turns: evidence.length,
			totalCostUsd: Number(spent.toFixed(6)),
			evidence,
		};
	},
};
