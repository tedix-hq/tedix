/**
 * Pure durable-step orchestration for ChatTurnWorkflow.
 *
 * The DO-bound class (`chat-turn-workflow.ts`) owns agent-stub acquisition and
 * RPC recovery; this module owns the step SEQUENCE and the terminal
 * agent-notify contract, so both are unit-testable without a Workflow harness
 * (same pattern as `cron.ts` vs the DO-bound cron tool).
 *
 * TERMINAL NOTIFY CONTRACT: the Agents SDK does NOT auto-notify the Agent when
 * a workflow run() returns — `onWorkflowComplete` fires only when the workflow
 * explicitly calls the durable `step.reportComplete(result)` (the run wrapper
 * auto-reports ERRORS only, via `_autoReportError` → `onWorkflowError`). Every
 * settled turn must therefore report completion here, or the Agent-side
 * terminal hooks never run: cron execution stamps stay `running` forever
 * (`lastSuccess: null`), and the wfctx dispatch
 * records / fan-out slots that `onWorkflowComplete` cleans up leak.
 */

import type { WorkflowStepConfig } from "cloudflare:workers";

/**
 * Retry budget for the IDEMPOTENT workflow steps. Each `step.do()` body RPCs
 * back into the DO; a worker REDEPLOY or DO eviction mid-step throws that
 * in-flight RPC. Without an explicit policy the step inherits the default retry
 * budget and can exhaust it before a fresh isolate is available. Native
 * terminal reconciliation then seals the run `failed` — the observed
 * `runtime_dropped`/deploy-collision drop (a delegated turn that goes silent at
 * a deploy and is never recovered). An explicit delayed-exponential retry rides
 * out the redeploy window (a redeploy is seconds; 5 attempts from 15s ≈
 * minutes) and re-drives the step on a fresh DO, where the settled fast-path /
 * dedup-keyed writes make the re-drive exactly-once for settlement.
 */
export const IDEMPOTENT_STEP_RETRY = {
	retries: { limit: 5, delay: "15 seconds", backoff: "exponential" },
} satisfies WorkflowStepConfig;

/**
 * The subset of the SDK's `AgentWorkflowStep` this orchestration uses: durable
 * step execution plus the durable completion report (an idempotent
 * `__agent_reportComplete_*` step that RPCs `onWorkflowComplete` on the Agent).
 */
export interface ChatTurnStepRunner {
	do<T>(
		name: string,
		config: WorkflowStepConfig,
		callback: () => Promise<T>,
	): Promise<T>;
	sleep(name: string, duration: `${number} seconds`): Promise<void>;
	reportComplete(result?: unknown): Promise<void>;
}

/** Agent-side operations the steps drive (bound to the DO stub by the class). */
export interface ChatTurnStepOps {
	/** `markChatWorkflowStarted` — the admission watchdog's first checkpoint. */
	markStarted(): Promise<boolean | void>;
	/**
	 * `runFacetWorkflowTurn` — the whole turn as ONE durable step, returned as a
	 * JSON string of `{ text, stopReason }` (serialized on the class side so the
	 * RPC value can be disposed there).
	 */
	runFacetTurn(computerContinuation?: number): Promise<string>;
	/** Observe the exact pending segment without invoking the model or a command. */
	readComputerExecutions?(
		computerContinuation: number,
		executionIds: string[],
	): Promise<{ ready: boolean; retryAfterSeconds: number }>;
}

export interface ChatTurnStepResult {
	text: string;
	stopReason: string;
	error?: string;
	billingCode?: string;
	toolCalls: Array<{ name: string; ok: boolean }>;
}

/**
 * Drive the durable chat-turn steps. Step NAMES and retry config are part of
 * the durable contract — in-flight instances resume by memoized step name, so
 * they must never change ("mark-workflow-started", "facet-turn").
 */
export async function driveChatTurnSteps(
	step: ChatTurnStepRunner,
	ops: ChatTurnStepOps,
): Promise<ChatTurnStepResult> {
	// First durable callback: proves the Workflow instance progressed beyond
	// admission/queueing and reached user code. The Agent-side watchdog restarts
	// the same instance id only when this checkpoint never lands.
	const admitted = await step.do(
		"mark-workflow-started",
		IDEMPOTENT_STEP_RETRY,
		async () => (await ops.markStarted()) !== false,
	);
	if (!admitted) {
		const canceled: ChatTurnStepResult = {
			text: "",
			stopReason: "canceled",
			toolCalls: [],
		};
		await step.reportComplete(canceled);
		return canceled;
	}

	// The whole turn — context assembly, the facet `chat()` loop (tools served
	// parent-side via the per-runId proxy registry), and settlement
	// (`commitAssistantTurn`: keyed assistant append, awaited ledger mirror,
	// memory effects, final broadcast) — runs as ONE durable step on the DO.
	// Idempotent; `step.do` memoizes the result so a post-settlement resume
	// never re-runs the model.
	let resultRaw = await step.do("facet-turn", IDEMPOTENT_STEP_RETRY, () =>
		ops.runFacetTurn(),
	);
	let computerContinuation = 0;
	// Pending native work is still the SAME run. Durable sleeps release the
	// invocation while the Agent's independent renewal alarm keeps its exact
	// admitted Attempt alive. Each segment and observation has a stable name:
	// retrying the workflow never replays a memoized model turn or its command.
	while (true) {
		const segment = JSON.parse(resultRaw);
		const pending = segment.pendingComputerExecutions;
		if (pending === undefined && segment.stopReason !== "computer_pending")
			break;
		if (
			segment.stopReason !== "computer_pending" ||
			!Array.isArray(pending) ||
			pending.length === 0 ||
			pending.some((id) => typeof id !== "string" || !id) ||
			new Set(pending).size !== pending.length
		) {
			throw new Error("Invalid pending computer execution segment");
		}
		const read = ops.readComputerExecutions;
		if (!read)
			throw new Error("Pending computer execution observer unavailable");
		for (let observation = 0; ; observation++) {
			const checkpoint = `${computerContinuation}-${observation}`;
			const status = await step.do(
				`computer-status-${checkpoint}`,
				IDEMPOTENT_STEP_RETRY,
				() => read(computerContinuation, pending),
			);
			if (status.ready === true) break;
			if (
				status.ready !== false ||
				!Number.isFinite(status.retryAfterSeconds) ||
				status.retryAfterSeconds < 1 ||
				status.retryAfterSeconds > 120
			) {
				throw new Error("Invalid computer execution observation delay");
			}
			await step.sleep(
				`computer-wait-${checkpoint}`,
				`${status.retryAfterSeconds} seconds`,
			);
		}
		computerContinuation++;
		resultRaw = await step.do(
			`facet-turn-continuation-${computerContinuation}`,
			IDEMPOTENT_STEP_RETRY,
			() => ops.runFacetTurn(computerContinuation),
		);
	}
	const result = JSON.parse(resultRaw) as {
		text: string;
		stopReason: string;
		error?: string;
		billingCode?: unknown;
		toolCalls?: unknown;
	};
	const toolCalls = Array.isArray(result.toolCalls)
		? result.toolCalls.flatMap((value) => {
				if (!value || typeof value !== "object") return [];
				const call = value as { name?: unknown; ok?: unknown };
				return typeof call.name === "string"
					? [{ name: call.name, ok: call.ok === true }]
					: [];
			})
		: [];

	const settled: ChatTurnStepResult = {
		text: result.text,
		stopReason: result.stopReason,
		...(result.error ? { error: result.error } : {}),
		...(typeof result.billingCode === "string"
			? { billingCode: result.billingCode }
			: {}),
		toolCalls,
	};

	// TERMINAL NOTIFY (see module header): durably report completion so the
	// Agent's `onWorkflowComplete` runs — it seals the cron execution stamp
	// `success` (with this result as the transitions source) and cleans up the
	// wfctx dispatch record + fan-out slot. Durable + idempotent: the SDK wraps
	// this as its own memoized `__agent_reportComplete_*` step, so a post-report
	// re-drive never double-notifies, and a transient RPC failure here retries
	// (or exhausts into the error path, whose failure seal is honest: the turn
	// itself settled idempotently in "facet-turn").
	await step.reportComplete(settled);

	return settled;
}
