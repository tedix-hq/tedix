/**
 * security-audit-loop — bounded security-audit goal-loop skill workflow.
 *
 * Implements the vulnerability-harness trust machinery as a durable Cloudflare
 * Workflow: dynamic threat modeling (Recon) → Hunt (claim-before-fileable) →
 * authority-separated cross-pass Validation with a PoC-on-untouched-source oracle
 * → gated patch proposals (never auto-applied). Every kernel turn, poll, and
 * inter-step wait is a durable step.do / step.sleep.
 *
 * The kernel is driven through env.MCP.home.* (declared in SKILL.md
 * capabilities.mcp). Only small fields are returned from each step.do; the large
 * run-set payload is consumed inside the step.
 *
 * params: { target, maxClasses?, budgetUsd?, pollAttempts?, sleepSeconds? }
 *
 * No conversationId param: ask is called without one, so the kernel routes
 * these turns to this caller's own agent thread rather than the operator's
 * home:main transcript (defaultHomeConversationIdForCaller).
 */

export default {
	async run(event, step, env) {
		const p = event.payload ?? {};
		const target = p.target;
		if (!target) throw new Error("security-audit-loop requires params.target");
		const maxClasses = Math.max(1, Math.min(Number(p.maxClasses ?? 4), 8));
		const budgetUsd = Number(p.budgetUsd ?? 0.5);
		const pollAttempts = Math.max(
			1,
			Math.min(Number(p.pollAttempts ?? 18), 40),
		);
		const sleepSeconds = Math.max(1, Math.min(Number(p.sleepSeconds ?? 3), 30));

		let spent = 0;

		// Submit one kernel turn and poll to terminal; return only small fields.
		const ask = async (label, content) => {
			const sub = await step.do(
				`ask-${label}`,
				{ timeout: "30 seconds" },
				async () => {
					const r = await env.MCP.home.ask({ content });
					return { runId: r?.run?.id ?? r?.task?.id ?? null };
				},
			);
			const runId = sub.runId;
			let settled = null;
			for (let i = 0; i < pollAttempts && !settled; i++) {
				const snap = await step.do(
					`poll-${label}-${i}`,
					{ timeout: "20 seconds" },
					async () => {
						// Single-run read (O(1)) — not the full conversation run-set.
						const res = await env.MCP.home.read_home_run({ homeRunId: runId });
						const run = res?.run;
						if (
							!run ||
							!["completed", "failed", "requires_approval"].includes(run.status)
						) {
							return { done: false };
						}
						const route = run.metadata?.kernelRoute ?? {};
						const body = run.metadata?.bodyExecutionResult ?? {};
						return {
							done: true,
							status: run.status,
							costUsd: body?.cost?.totalCostUsd ?? 0,
							answer: String(route.answer ?? body.summary ?? "").slice(0, 600),
						};
					},
				);
				if (snap.done) settled = snap;
				else if (i < pollAttempts - 1)
					await step.sleep(`wait-${label}-${i}`, `${sleepSeconds} seconds`);
			}
			spent += settled?.costUsd ?? 0;
			return {
				runId,
				answer: settled?.answer ?? "",
				costUsd: settled?.costUsd ?? 0,
			};
		};

		// 1. RECON — dynamic threat modeling.
		const recon = await ask(
			"recon",
			`You are scoping a security audit of: ${target}. List up to ${maxClasses} ` +
				`security threat classes specific to this target, one per line, no prose. ` +
				`Prefer repo-specific classes over a generic checklist.`,
		);
		const classes = recon.answer
			.split("\n")
			.map((l) => l.replace(/^[\s\d.*-]+/, "").trim())
			.filter((l) => l.length > 0)
			.slice(0, maxClasses);

		const findings = [];
		let stall = 0;

		for (let idx = 0; idx < classes.length; idx++) {
			if (spent > budgetUsd) break;
			const cls = classes[idx];

			// 2. HUNT — claim-before-fileable: threat model + candidate + PoC-on-untouched.
			const hunt = await ask(
				`hunt-${idx}`,
				`Act as a security hunter auditing: ${target}. Threat class: "${cls}". ` +
					`A finding is ONLY fileable if you state, in this order: ` +
					`(1) THREAT MODEL — attacker, capability, and trust boundary; ` +
					`(2) FINDING — one concrete candidate; ` +
					`(3) POC — a proof of concept that would run against the ORIGINAL, UNTOUCHED source ` +
					`(do not assume edits to force it). If you cannot produce all three, reply exactly NONE.`,
			);
			if (/^\s*NONE\s*$/i.test(hunt.answer) || !hunt.answer.trim()) {
				stall += 1;
				if (stall > 2) break;
				continue;
			}

			// 3. VALIDATE — authority-separated cross-pass: may only judge, never file.
			const verdict = await ask(
				`validate-${idx}`,
				`You are an ADVERSARIAL VALIDATOR. You may ONLY judge; you may NOT produce findings of ` +
					`your own. Try to REFUTE the candidate below. Reply with EXACTLY one word on the first ` +
					`line: REAL only if it has BOTH a stated threat model AND a concrete PoC that runs ` +
					`against untouched source; otherwise REJECT. Then one short reason.\n\nCANDIDATE:\n${hunt.answer}`,
			);
			const isReal = /\bREAL\b/i.test(
				verdict.answer.split("\n")[0] ?? verdict.answer,
			);
			if (!isReal) {
				findings.push({
					class: cls,
					status: "rejected",
					huntRunId: hunt.runId,
					validateRunId: verdict.runId,
				});
				stall = 0;
				continue;
			}
			stall = 0;

			// 4. PATCH — gated proposal only; never applied here.
			const patch = await ask(
				`patch-${idx}`,
				`Propose a MINIMAL patch for the confirmed finding below. Output the patch as a PROPOSAL ` +
					`for human approval only — do NOT claim to have applied it. Keep it focused on the ` +
					`finding.\n\nFINDING:\n${hunt.answer}`,
			);
			findings.push({
				class: cls,
				status: "confirmed",
				huntRunId: hunt.runId,
				validateRunId: verdict.runId,
				patchRunId: patch.runId,
				finding: hunt.answer.slice(0, 400),
				proposedPatch: patch.answer.slice(0, 400),
				gated: "requires_human_approval (respond_home_approval)",
			});
		}

		const confirmed = findings.filter((f) => f.status === "confirmed");
		const rejected = findings.filter((f) => f.status === "rejected");
		return {
			target,
			// Funnel survival, not a recall claim.
			funnel: {
				threatClasses: classes.length,
				candidatesHunted: findings.length,
				survivedValidation: confirmed.length,
				rejectedByValidator: rejected.length,
				proposedPatches: confirmed.length,
			},
			totalCostUsd: Number(spent.toFixed(6)),
			stopReason: spent > budgetUsd ? "budget_exceeded" : "classes_exhausted",
			classes,
			findings,
			note: "All patches are proposals gated on human approval; this skill never mutates the target.",
		};
	},
};
