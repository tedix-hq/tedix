import type { ComputerEnvironment } from "./computer-environment";
import type { ComputerWorkspaceScope } from "./computer-workspace-scope";
import { AUTONOMOUS_NOTICE } from "./scheduled-task-prompt";

/**
 * A command that outlived the inline wait, and the identity needed to hand its
 * completion back to the tedi as a durable wake.
 *
 * Why this exists: a detached command used to be the model's problem: the
 * receipt handed back an `executionId` and the tool descriptions told it to
 * "keep reading the same executionId until terminal". Every one of those reads
 * is a model round spent on a process the RUNTIME can watch for free, and a
 * model asked to guess when to look either burns rounds looking too early or
 * abandons the command. The durable schedule that already watches Workflow
 * terminality (`reconcileChatWorkflowTerminal`) watches this instead, and the
 * completion arrives as a turn — one notification, exactly once.
 *
 * The `environment` is captured at detach because that is the only body that
 * can answer for this process, and a replacement lease never inherits it.
 */
export interface ComputerExecutionWakeRecord {
	executionId: string;
	command: string;
	environment: ComputerEnvironment;
	/** Conversation the command was launched from; the wake lands back in it. */
	sessionKey: string;
	workItemId?: string;
	homeRunId?: string;
	/** Owned by the original workflow, never a separate cron turn. */
	computerContinuation?: number;
	terminalReceipt?: Record<string, unknown>;
	/** Only the owning model turn may acknowledge the terminal output it read. */
	collectedByRunId?: string;
	/** Run that launched the command, carried as provenance for the wake turn. */
	launchedByRunId?: string;
	detachedAt: number;
	/** How many times the watcher has already looked. */
	attempt: number;
}

export const computerExecutionWakeKey = (executionId: string) =>
	`computer-exec-wake:${executionId}`;

/** Work continuations require the original workflow and its admitted fence. */
export const canDispatchComputerExecutionWake = (
	record: ComputerExecutionWakeRecord,
): boolean => !record.workItemId;

type ExecutionTurnProvenance = {
	runId?: string;
	workItemId?: string;
	sessionKey?: string;
};

/** Captured turn identity wins; unrelated ambient turns never donate a session. */
export function computerExecutionProvenance(
	scope: ComputerWorkspaceScope,
	turn: ExecutionTurnProvenance | null,
	active: ExecutionTurnProvenance | null,
	current: ExecutionTurnProvenance | null,
): { sessionKey?: string; workItemId?: string } {
	const workItemId =
		scope.kind === "delegated-run" ? scope.key : turn?.workItemId;
	if (workItemId && turn?.workItemId && workItemId !== turn.workItemId)
		throw new Error(
			"computer_continuation_failed: computer scope differs from owning Work",
		);
	if (scope.kind === "conversation")
		return { sessionKey: scope.key, workItemId };
	const matches = (candidate: ExecutionTurnProvenance | null) =>
		Boolean(
			turn?.runId &&
			candidate?.runId === turn.runId &&
			(!workItemId || candidate?.workItemId === workItemId),
		);
	const sessionKey =
		turn?.sessionKey ??
		(matches(active) ? active?.sessionKey : undefined) ??
		(matches(current) ? current?.sessionKey : undefined) ??
		(!workItemId && !turn?.runId ? current?.sessionKey : undefined);
	return { sessionKey, workItemId };
}

export async function collectComputerExecutionWake(
	storage: Pick<DurableObjectStorage, "get" | "put" | "delete">,
	executionId: string,
	collector: { runId?: string; workItemId?: string } | null,
): Promise<void> {
	const key = computerExecutionWakeKey(executionId);
	const record = await storage.get<ComputerExecutionWakeRecord>(key);
	if (!record?.workItemId) {
		await storage.delete(key);
	} else if (
		collector?.runId &&
		collector.runId === record.launchedByRunId &&
		collector.workItemId === record.workItemId
	) {
		await storage.put(key, { ...record, collectedByRunId: collector.runId });
	}
}

/**
 * How long the runtime keeps watching one detached command.
 *
 * Matches the maximum `killAfterMs` the exec tool accepts (6h), so the watcher
 * outlives every command the model is allowed to ask for. Past it the process
 * is the workstation lease's problem, not an open promise of a notification.
 */
export const COMPUTER_EXECUTION_WAKE_DEADLINE_MS = 21_600_000;

/**
 * Backoff for the watcher's look-ins. Short at first because most detached
 * commands (typecheck, test, install) finish within a minute or two of the
 * 90s inline wait; flat at two minutes afterwards so a six-hour build costs
 * ~180 alarms rather than ~1400. None of this is model-visible: a look-in
 * costs a DO alarm, not a round.
 */
export function computerExecutionWakeDelaySeconds(attempt: number): number {
	if (attempt <= 0) return 15;
	if (attempt === 1) return 30;
	if (attempt === 2) return 60;
	return 120;
}

/** Presentation bound: the full logs stay in the execution's artifact refs. */
export const COMPUTER_EXECUTION_WAKE_OUTPUT_CHARS = 4_000;

function tail(value: unknown): string {
	const text = typeof value === "string" ? value : "";
	return text.length <= COMPUTER_EXECUTION_WAKE_OUTPUT_CHARS
		? text
		: `[... ${text.length - COMPUTER_EXECUTION_WAKE_OUTPUT_CHARS} earlier characters omitted ...]\n${text.slice(-COMPUTER_EXECUTION_WAKE_OUTPUT_CHARS)}`;
}

function outcome(receipt: Record<string, unknown>): string {
	if (receipt.canceled === true) return "canceled";
	if (receipt.timedOut === true) return "killed by its killAfterMs deadline";
	return receipt.exitCode === 0 ? "succeeded" : "failed";
}

/**
 * The notification itself.
 *
 * It names the command, because a turn woken hours later has compacted away
 * the tool call that launched it, and it names the executionId, because the
 * artifact refs and any follow-up read are keyed by it.
 */
export function formatComputerExecutionWake(
	record: ComputerExecutionWakeRecord,
	receipt: Record<string, unknown>,
	now: number,
): string {
	const stdout = tail(receipt.stdoutTail ?? receipt.stdout);
	const stderr = tail(receipt.stderrTail ?? receipt.stderr);
	return [
		`A command you started on this computer has finished — it ${outcome(receipt)}.`,
		`executionId: ${record.executionId}`,
		`command: ${record.command}`,
		`exitCode: ${typeof receipt.exitCode === "number" ? receipt.exitCode : "unknown"}`,
		`ran for: ${Math.max(0, Math.round((now - record.detachedAt) / 1000))}s after it detached`,
		"",
		"This is the single completion notification for that command. Its output is below; do not re-run it and do not read it again unless you need more than this tail.",
		"",
		AUTONOMOUS_NOTICE,
		"",
		`stdout:\n${stdout || "(empty)"}`,
		"",
		`stderr:\n${stderr || "(empty)"}`,
	].join("\n");
}

export type ComputerExecutionWakeDecision =
	| { action: "wake"; text: string }
	| { action: "rearm"; attempt: number; delaySeconds: number }
	| { action: "abandon"; reason: string };

/**
 * What the watcher does with one look at a detached command.
 *
 * Pure so the ladder and the deadline can be tested without a workstation: the
 * DO side is a storage read, a status read, and whichever of these three the
 * decision names.
 */
export function resolveComputerExecutionWake(
	record: ComputerExecutionWakeRecord,
	receipt: Record<string, unknown>,
	now: number,
): ComputerExecutionWakeDecision {
	if (receipt.terminal === true)
		return {
			action: "wake",
			text: formatComputerExecutionWake(record, receipt, now),
		};
	// The body no longer knows this process: the lease was replaced or closed,
	// and there is nothing left to wake with. Its files went with it.
	if (receipt.found === false)
		return {
			action: "abandon",
			reason: "the computer no longer knows this execution",
		};
	if (now - record.detachedAt >= COMPUTER_EXECUTION_WAKE_DEADLINE_MS)
		return {
			action: "abandon",
			reason: "the command outlived the maximum execution deadline",
		};
	const attempt = record.attempt + 1;
	return {
		action: "rearm",
		attempt,
		delaySeconds: computerExecutionWakeDelaySeconds(attempt),
	};
}
