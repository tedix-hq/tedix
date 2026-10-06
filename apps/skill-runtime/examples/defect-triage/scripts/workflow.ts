/* tedix
name: defect-triage
description: Phase-gated Computer defect triage with a closed verification verdict.
capabilities:
  network: false
  reason:
    maxCalls: 3
  mcp:
    tedi: [open_computer, exec, read_execution, cancel_execution]
  expectedAnnotations:
    destructive: true
    readOnly: false
*/

const EFFECT_STEP = {
	retries: { limit: 1, delay: "1 second" },
	timeout: "2 minutes",
};
const REASON_STEP = {
	retries: { limit: 1, delay: "1 second" },
	timeout: "1 minute",
};

function requiredText(value, name) {
	if (typeof value !== "string" || !value.trim() || value.length > 2_000)
		throw new Error(
			`${name} must be a non-empty string of at most 2000 characters`,
		);
	return value.trim();
}

function tail(value, max = 2_000) {
	return typeof value === "string" ? value.slice(-max) : "";
}

function commandReceipt(value) {
	if (!value || typeof value !== "object")
		throw new Error(
			"Computer returned an unknown command outcome; do not replay it",
		);
	const id = typeof value.executionId === "string" ? value.executionId : null;
	const exitCode = typeof value.exitCode === "number" ? value.exitCode : null;
	const terminal = value.terminal === true || exitCode !== null;
	if (
		!terminal &&
		(!id || (value.running !== true && value.status !== "running"))
	)
		throw new Error(
			"Computer returned an unknown command outcome; do not replay it",
		);
	return {
		terminal,
		executionId: id,
		exitCode,
		stdout: tail(value.stdout),
		stderr: tail(value.stderr),
		timedOut: value.timedOut === true,
	};
}

async function runCommand(phase, command, step, env, maxReads) {
	let receipt = await step.do(`${phase}-dispatch`, EFFECT_STEP, async () =>
		commandReceipt(await env.MCP.tedi.exec({ command })),
	);
	for (let i = 0; !receipt.terminal && i < maxReads; i++) {
		await step.sleep(`${phase}-wait-${i}`, "10 seconds");
		const executionId = receipt.executionId;
		receipt = await step.do(`${phase}-read-${i}`, EFFECT_STEP, async () =>
			commandReceipt(await env.MCP.tedi.read_execution({ executionId })),
		);
		if (receipt.executionId && receipt.executionId !== executionId)
			throw new Error("Computer execution identity changed during observation");
	}
	if (receipt.terminal) return receipt;
	const executionId = receipt.executionId;
	await step.do(`${phase}-cancel`, EFFECT_STEP, async () =>
		env.MCP.tedi.cancel_execution({ executionId }),
	);
	return { ...receipt, timedOut: true };
}

function verdictFrom(text) {
	const firstLine = text.split(/\r?\n/, 1)[0]?.trim().toLowerCase();
	return firstLine === "bug" || firstLine === "intended_behavior"
		? firstLine
		: "unclear";
}

export default {
	async run(event, step, env) {
		const p = event.payload ?? {};
		const runId = env.__RUN_CONTEXT__?.runId ?? null;
		const target = requiredText(p.target, "target");
		const entityKey = requiredText(p.entityKey, "entityKey");
		const revision = requiredText(p.revision, "revision");
		const expectedBehavior = requiredText(
			p.expectedBehavior,
			"expectedBehavior",
		);
		const reproduceCommand = requiredText(
			p.reproduceCommand,
			"reproduceCommand",
		);
		const fixCommand =
			p.fixCommand == null ? null : requiredText(p.fixCommand, "fixCommand");
		const maxReads = Math.max(1, Math.min(Number(p.maxReads ?? 18), 30));
		if (!Number.isInteger(maxReads))
			throw new Error("maxReads must be an integer");

		const computer = await step.do(
			"reproduce-open-computer",
			EFFECT_STEP,
			async () =>
				env.MCP.tedi.open_computer(
					p.repository === true ? { repository: true } : {},
				),
		);
		if (computer?.ready !== true)
			return {
				runId,
				entityKey,
				revision,
				verdict: "unclear",
				stopReason: "computer_not_ready",
			};

		const reproduction = await runCommand(
			"reproduce",
			reproduceCommand,
			step,
			env,
			maxReads,
		);
		if (
			!reproduction.terminal ||
			reproduction.exitCode === null ||
			reproduction.timedOut
		)
			return {
				runId,
				entityKey,
				revision,
				verdict: "unclear",
				stopReason: "reproduction_timeout",
				executionId: reproduction.executionId,
			};

		const context = `Target: ${target}\nExpected: ${expectedBehavior}\nReproduction exit code: ${reproduction.exitCode}\nstdout: ${reproduction.stdout}\nstderr: ${reproduction.stderr}`;
		const diagnosis = await step.do("diagnose", REASON_STEP, async () => {
			const answer = await env.REASON.ask({
				key: "diagnose",
				prompt: `Diagnose the observed behavior without changing files. State the likely cause and one falsifiable check in at most 100 words.\n${context}`,
			});
			return tail(answer.text, 1_000);
		});

		const verification = await step.do("verify", REASON_STEP, async () => {
			const answer = await env.REASON.ask({
				key: "verify",
				prompt: `Independently judge whether this is a defect. Your first line must be exactly bug, intended_behavior, or unclear. Choose unclear if evidence is insufficient. Then give one short reason. Do not propose a fix.\n${context}`,
			});
			return tail(answer.text, 1_000);
		});
		const verdict = verdictFrom(verification);
		const base = {
			runId,
			entityKey,
			revision,
			verdict,
			reproductionExitCode: reproduction.exitCode,
			diagnosis,
			verification,
		};
		if (verdict !== "bug")
			return { ...base, stopReason: "verification_early_exit" };
		if (!fixCommand)
			return { ...base, stopReason: "fix_command_not_authorized" };

		const fixPlan = await step.do("fix-plan", REASON_STEP, async () => {
			const answer = await env.REASON.ask({
				key: "fix-plan",
				prompt: `A separate verifier classified this as a bug. Explain how to check the caller-authorized fix command without changing files yourself.\n${context}\nProposed command: ${fixCommand}`,
			});
			return tail(answer.text, 1_000);
		});
		const fix = await runCommand("fix", fixCommand, step, env, maxReads);
		if (!fix.terminal || fix.exitCode !== 0)
			return {
				...base,
				fixPlan,
				fixExitCode: fix.exitCode,
				stopReason: "fix_failed_or_unknown",
			};
		const recheck = await runCommand(
			"fix-recheck",
			reproduceCommand,
			step,
			env,
			maxReads,
		);
		return {
			...base,
			fixPlan,
			fixExitCode: fix.exitCode,
			recheckExitCode: recheck.exitCode,
			stopReason:
				recheck.terminal && recheck.exitCode === 0
					? "fixed"
					: "recheck_failed_or_unknown",
		};
	},
};
