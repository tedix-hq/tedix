/** Authoritative terminal reconciliation for tracked ChatTurnWorkflow runs. */

import { scrubText } from "@tedix/context-core/trace-safety";

export const WORKFLOW_TERMINAL_RECONCILE_DELAY_SECONDS = 30;
export const WORKFLOW_TERMINAL_RECONCILE_MAX_POLLS = 20;

/** Arms the bounded native-status safety net after a workflow starts. */
export async function armWorkflowTerminalReconciliation(
	workflowInstanceId: string,
	schedule: (
		delay: number,
		method: "reconcileChatWorkflowTerminal",
		input: { workflowInstanceId: string; attempt: number },
		options: { idempotent: boolean; retry: { maxAttempts: number } },
	) => Promise<unknown>,
): Promise<void> {
	try {
		await schedule(
			WORKFLOW_TERMINAL_RECONCILE_DELAY_SECONDS,
			"reconcileChatWorkflowTerminal",
			{ workflowInstanceId, attempt: 0 },
			{ idempotent: true, retry: { maxAttempts: 3 } },
		);
	} catch (error) {
		console.warn(
			`[isolate.workflow] terminal reconciliation arm failed id=${workflowInstanceId}:`,
			error,
		);
	}
}

/**
 * Bounded ceiling on transient-reset RE-DRIVES of one native instance (fix (b)
 * DEPLOY-WINDOW DO RESETS). A deploy/OOM/storage-reset that retires the DO
 * mid-step is a transient runtime loss, not a turn failure, so the reconciler
 * restarts the instance instead of sealing `lastSuccess:false`. Bounded so a
 * genuinely poisoned run (one that resets every attempt) still terminalizes
 * rather than re-driving forever. A deploy window is seconds; three re-drives
 * over the reconcile poll cadence comfortably rides one out.
 */
export const WORKFLOW_TERMINAL_MAX_REDRIVES = 3;

/**
 * How long a pending retry owns its run against the platform orphan sweep.
 * Covers the native step retry backoff plus the full terminal-reconcile poll
 * window (20 x 30 s); a run that is still silent afterwards is swept.
 */
export const WORKFLOW_RETRY_OWNERSHIP_MS = 30 * 60_000;

/**
 * `step.retry` payload that tells the orphan sweep this runtime still owns the
 * run: a transient loss (isolate memory reset, platform Workflows error) left
 * it silent, and a retry is about to rerun it.
 */
export function workflowRetryOwnershipPayload(input: {
	operation: "workflow_attempt_retry" | "workflow_redrive";
	redriveCount: number;
	error: string;
	now: number;
}): Record<string, unknown> {
	const error = input.error.replace(/\s+/g, " ").trim();
	return {
		operation: input.operation,
		redriveCount: input.redriveCount,
		error: error.length > 300 ? `${error.slice(0, 297)}...` : error,
		retryOwnedUntil: new Date(
			input.now + WORKFLOW_RETRY_OWNERSHIP_MS,
		).toISOString(),
	};
}

export type WorkflowTerminalDecision =
	| { action: "complete" }
	| { action: "fail" }
	| { action: "redrive" }
	| { action: "defer" };

/**
 * Agents SDK's onWorkflowError callback is attempt-scoped: it can run while
 * Cloudflare is retrying the native Workflow instance. Only native terminal
 * status is allowed to settle Tedix's run, cron, and fan-out ledgers.
 *
 * A native `errored`/`terminated` settlement normally seals failure — EXCEPT
 * when the terminal error is a transient runtime loss (deploy-window DO reset,
 * isolate OOM, storage reset: `opts.errorIsTransientReset`) and the instance has
 * re-drives left (`opts.redrivesRemaining`). Those re-drive the idempotent
 * workflow on a fresh isolate rather than darking the cron. The transient
 * classification + the remaining-budget check are supplied by the caller (which
 * owns the error text and the persisted re-drive counter) so this stays pure.
 */
export function decideWorkflowTerminalReconciliation(
	status?: string,
	opts?: { errorIsTransientReset?: boolean; redrivesRemaining?: boolean },
): WorkflowTerminalDecision {
	if (status === "complete") return { action: "complete" };
	if (status === "errored" || status === "terminated") {
		if (opts?.errorIsTransientReset && opts?.redrivesRemaining) {
			return { action: "redrive" };
		}
		return { action: "fail" };
	}
	return { action: "defer" };
}

/**
 * Operator-visible text for a turn that ended without producing a reply.
 *
 * A turn that dies after admission writes `run.failed` to the ledger, which the
 * kernel sees — but the CONVERSATION got nothing, so an operator reading it saw
 * their own message and silence. Silence is indistinguishable from thinking,
 * which is the worst failure mode for trust: it reads as "the tedi is ignoring
 * me" rather than "the turn crashed". Every terminal failure now leaves a row in the thread.
 *
 * The reason is included because the operator's next action depends on it, but
 * it is flattened and truncated — a raw multi-line stack in a chat bubble is
 * noise, not evidence; the full error stays on the ledger event.
 */
export function turnFailureNoticeText(error: string): string {
	const reason = scrubText(error).replace(/\s+/g, " ").trim();
	const clipped =
		reason.length > 300 ? `${reason.slice(0, 297).trimEnd()}...` : reason;
	if (
		/\b(?:inference daily budget|inference (?:token )?budget) (?:is )?exhausted\b/i.test(
			reason,
		)
	) {
		return `This turn stopped before replying: the daily inference budget is exhausted. It will run again once the budget window resets. (${clipped})`;
	}
	return `This turn ended without a reply — it failed after being accepted, so nothing was produced. Reason: ${clipped || "unknown error"}`;
}

export const MAX_DELAYED_TERMINAL_RECONCILIATIONS = 16;
interface TerminalScheduleHost {
	ctx: { storage: Pick<DurableObjectStorage, "get"> };
	listSchedules(): Promise<
		Array<{ id: string; callback: string; payload: unknown }>
	>;
	cancelSchedule(id: string): Promise<boolean>;
	schedule(
		delay: number,
		callback: "reconcileChatWorkflowTerminal",
		payload: { workflowInstanceId: string; attempt: number },
		options: { idempotent: boolean; retry: { maxAttempts: number } },
	): Promise<unknown>;
}
const scheduleLocks = new WeakMap<object, Promise<unknown>>();
/** Serialize inventory + insertion across every workflow facade of this parent. */
export async function scheduleWorkflowTerminalReconciliation(
	host: TerminalScheduleHost,
	input: { workflowInstanceId: string; attempt: number },
	delay = WORKFLOW_TERMINAL_RECONCILE_DELAY_SECONDS,
): Promise<unknown> {
	const storage = host.ctx.storage;
	const run = async () => {
		const schedules = (await host.listSchedules()).filter(
			(row) => row.callback === "reconcileChatWorkflowTerminal",
		);
		let retained = 0;
		const seen = new Set<string>();
		for (const row of schedules) {
			const id = (row.payload as { workflowInstanceId?: string } | null)
				?.workflowInstanceId;
			if (
				!id ||
				id === input.workflowInstanceId ||
				seen.has(id) ||
				!(await storage.get(`wfctx:${id}`)) ||
				retained >= MAX_DELAYED_TERMINAL_RECONCILIATIONS
			) {
				await host.cancelSchedule(row.id);
			} else {
				seen.add(id);
				retained++;
			}
		}
		if (retained >= MAX_DELAYED_TERMINAL_RECONCILIATIONS) {
			console.warn({
				event: "tedi.workflow.terminal_schedule_cap",
				workflowInstanceId: input.workflowInstanceId,
				cap: MAX_DELAYED_TERMINAL_RECONCILIATIONS,
			});
			return;
		}
		if (!(await storage.get(`wfctx:${input.workflowInstanceId}`))) return;
		return host.schedule(delay, "reconcileChatWorkflowTerminal", input, {
			idempotent: true,
			retry: { maxAttempts: 3 },
		});
	};
	const next = (scheduleLocks.get(storage) ?? Promise.resolve()).then(run, run);
	scheduleLocks.set(
		storage,
		next.catch(() => {}),
	);
	return next;
}
export async function cancelWorkflowTerminalReconciliations(
	host: Pick<TerminalScheduleHost, "ctx" | "listSchedules" | "cancelSchedule">,
	workflowInstanceId: string,
): Promise<void> {
	const storage = host.ctx.storage;
	const run = async () => {
		for (const row of await host.listSchedules()) {
			if (
				row.callback === "reconcileChatWorkflowTerminal" &&
				(row.payload as { workflowInstanceId?: string } | null)
					?.workflowInstanceId === workflowInstanceId
			)
				await host.cancelSchedule(row.id);
		}
	};
	const next = (scheduleLocks.get(storage) ?? Promise.resolve()).then(run, run);
	scheduleLocks.set(
		storage,
		next.catch(() => {}),
	);
	return next;
}
