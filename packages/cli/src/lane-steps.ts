import type { WorkAttemptStepKind } from "@tedix/api-contract/schemas/work-attempt-steps";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { scrubText } from "@tedix/context-core/trace-safety";

/** One line of a run's log, as people watching the task see it. */
export interface LaneStep {
	kind: WorkAttemptStepKind;
	text: string;
	/** Only on a question: the short answers the agent offers. */
	choices?: string[];
}

/** What someone sent to a run in progress. */
export interface RunMessage {
	id: string;
	kind: "follow_up" | "stop";
	body: string;
	senderType: string;
	senderId: string;
	/** Send now may interrupt the active turn if it cannot be steered. */
	interrupt?: boolean;
	createdAt?: string;
}

export const STEP_TEXT_LIMIT = 500;
const COMMAND_LIMIT = 300;
const STEP_BATCH = 50;
const STEP_BUFFER = 500;
/** How often the runner calls `tick`, and a run with new steps sends them. */
export const RUN_STEP_FLUSH_MS = 5_000;
/** How often a run with nothing to send asks for messages. */
export const RUN_STEP_POLL_MS = 15_000;
/**
 * The server allows one caller 30 step calls a minute across all its runs, so
 * the runs of one runner share 24: each sends at most once per this many
 * milliseconds times the number of runs.
 */
const RUN_STEP_SHARE_MS = 2_500;
const RUN_STEP_BACKOFF_MAX_MS = 60_000;
const RATE_LIMITED = /rate limit exceeded|too many requests|\b429\b/i;

/** Step text is masked for secret shapes and bounded; it is never reviewed. */
export function stepText(value: unknown, limit = STEP_TEXT_LIMIT): string {
	return typeof value === "string"
		? scrubText(value).trim().slice(0, limit)
		: "";
}

/**
 * The steps one agent event stands for. Only what the agent said and which
 * command, tool or file it touched: never tool output or file contents.
 * Shapes this runner does not know produce no step.
 */
export function laneAgentSteps(
	executor: "codex" | "claude-code",
	event: unknown,
): LaneStep[] {
	if (!isRecord(event)) return [];
	const steps: LaneStep[] = [];
	const add = (kind: LaneStep["kind"], text: string) => {
		if (text) steps.push({ kind, text: text.slice(0, STEP_TEXT_LIMIT) });
	};
	if (executor === "codex") {
		if (event.type === "error") add("error", stepText(event.message));
		if (event.type === "turn.failed" && isRecord(event.error))
			add("error", stepText(event.error.message));
		if (
			event.type === "turn/completed" &&
			isRecord(event.turn) &&
			isRecord(event.turn.error)
		)
			add("error", stepText(event.turn.error.message));
		const item =
			event.type === "item.completed" || event.type === "item/completed"
				? event.item
				: undefined;
		if (!isRecord(item)) return steps;
		if (item.type === "agent_message" || item.type === "agentMessage")
			add("message", stepText(item.text));
		if (item.type === "command_execution" || item.type === "commandExecution") {
			const command = stepText(item.command, COMMAND_LIMIT);
			const exitCode = item.exit_code ?? item.exitCode;
			if (command)
				add(
					"command",
					typeof exitCode === "number"
						? `${command} (exit ${exitCode})`
						: command,
				);
		}
		if (
			(item.type === "file_change" || item.type === "fileChange") &&
			Array.isArray(item.changes)
		)
			add(
				"file_change",
				stepText(
					item.changes
						.flatMap((change) =>
							isRecord(change) && typeof change.path === "string"
								? [change.path]
								: [],
						)
						.join(", "),
				),
			);
		if (
			(item.type === "mcp_tool_call" || item.type === "mcpToolCall") &&
			typeof item.server === "string" &&
			typeof item.tool === "string"
		)
			add("tool", stepText(`${item.server}.${item.tool}`));
		if (item.type === "error") add("error", stepText(item.message));
		return steps;
	}
	if (
		event.type === "assistant" &&
		isRecord(event.message) &&
		Array.isArray(event.message.content)
	)
		for (const block of event.message.content) {
			if (!isRecord(block)) continue;
			if (block.type === "text") add("message", stepText(block.text));
			if (block.type === "tool_use" && typeof block.name === "string") {
				const command =
					block.name === "Bash" && isRecord(block.input)
						? stepText(block.input.command, COMMAND_LIMIT)
						: "";
				add("tool", stepText(command ? `Bash: ${command}` : block.name));
			}
		}
	if (event.type === "result" && event.is_error === true)
		add(
			"error",
			stepText(event.result, COMMAND_LIMIT) || "The agent ended with an error",
		);
	return steps;
}

/** The server this runner talks to has no step tool; the run goes on without it. */
export class RunStepsUnavailableError extends Error {}

export type SendRunSteps = (
	steps: Array<LaneStep & { seq: number; at: number }>,
	appliedMessageIds: string[],
) => Promise<unknown>;

/**
 * Buffers one run's steps and sends them in order. Each send also returns the
 * messages people sent to the run. The server returns a message again until
 * this run reports it applied, so each one is passed on once, by id. A failed
 * send keeps its steps and applied ids for retry. Timed sends never throw;
 * endTurn refuses to finish when it cannot check for follow-ups after retrying.
 */
export function createRunStepLog(options: {
	seq?: number;
	send: SendRunSteps;
	onSeq?: (seq: number) => void;
	onMessage: (message: RunMessage) => void;
	log: (event: string, detail: string) => void;
	/** How many runs this runner has under way; they share one call budget. */
	runs?: () => number;
	now?: () => number;
}) {
	const now = options.now ?? Date.now;
	let seq = options.seq ?? 0;
	let buffer: Array<LaneStep & { seq: number; at: number }> = [];
	let applied: string[] = [];
	let unavailable = false;
	let failing = false;
	let sentAt = Number.NEGATIVE_INFINITY;
	// After a rate-limit refusal: the wait before the next timed send, and
	// the time before which a send that is refused again is not logged.
	let backoffMs = 0;
	let quietUntil = Number.NEGATIVE_INFINITY;
	let inFlight: Promise<boolean> | undefined;
	const seen = new Set<string>();
	const sendOnce = async (): Promise<boolean> => {
		const steps = buffer.slice(0, STEP_BATCH);
		const ids = [...applied];
		let result: unknown;
		sentAt = now();
		try {
			result = await options.send(steps, ids);
		} catch (error) {
			if (error instanceof RunStepsUnavailableError) {
				unavailable = true;
				buffer = [];
				applied = [];
				options.log(
					"run-steps-unavailable",
					`This run goes on without a step log: ${error.message}`,
				);
			} else if (/\bSTALE_ATTEMPT\b/.test(String(error))) {
				// The Attempt is no longer this run's; the lease check ends the run.
				unavailable = true;
				buffer = [];
				applied = [];
				options.log(
					"run-steps-stopped",
					"The Attempt is stale; this run sends no more steps",
				);
			} else if (RATE_LIMITED.test(String(error))) {
				backoffMs = Math.min(
					RUN_STEP_BACKOFF_MAX_MS,
					Math.max(RUN_STEP_FLUSH_MS, backoffMs) * 2,
				);
				if (sentAt >= quietUntil) {
					quietUntil = sentAt + backoffMs;
					options.log(
						"run-steps-failed",
						`Next send in ${backoffMs / 1000} s: ${String(error).slice(0, 400)}`,
					);
				}
			} else if (!failing) {
				failing = true;
				options.log("run-steps-failed", String(error).slice(0, 400));
			}
			return false;
		}
		failing = false;
		backoffMs = 0;
		quietUntil = Number.NEGATIVE_INFINITY;
		const sent = new Set(steps.map((step) => step.seq));
		buffer = buffer.filter((step) => !sent.has(step.seq));
		applied = applied.filter((id) => !ids.includes(id));
		const pending =
			isRecord(result) && Array.isArray(result.pending) ? result.pending : [];
		for (const message of pending) {
			if (
				!isRecord(message) ||
				typeof message.id !== "string" ||
				(message.kind !== "follow_up" && message.kind !== "stop") ||
				seen.has(message.id)
			)
				continue;
			seen.add(message.id);
			try {
				options.onMessage({
					id: message.id,
					kind: message.kind,
					body: typeof message.body === "string" ? message.body : "",
					senderType:
						typeof message.senderType === "string"
							? message.senderType
							: "unknown",
					senderId:
						typeof message.senderId === "string" ? message.senderId : "",
					...(message.kind === "follow_up" && message.interrupt === true
						? { interrupt: true }
						: {}),
					...(typeof message.createdAt === "string"
						? { createdAt: message.createdAt }
						: {}),
				});
			} catch (error) {
				options.log("run-message-failed", String(error).slice(0, 400));
			}
		}
		return true;
	};
	const round = () =>
		(inFlight ??= (async () => {
			for (let sends = 0; sends < 10; sends++) {
				if (!(await sendOnce())) return false;
				if (!buffer.length && !applied.length) return true;
			}
			return false;
		})().finally(() => {
			inFlight = undefined;
		}));
	return {
		add(kind: LaneStep["kind"], text: string, choices?: string[]) {
			const bounded = stepText(text);
			if (!bounded) return;
			const offered = (choices ?? [])
				.map((choice) => stepText(choice, 100))
				.filter(Boolean);
			const step = {
				seq: seq++,
				at: Date.now(),
				kind,
				text: bounded,
				...(kind === "question" && offered.length >= 2
					? { choices: offered.slice(0, 5) }
					: {}),
			};
			if (!unavailable) {
				buffer.push(step);
				if (buffer.length > STEP_BUFFER) buffer.shift();
				options.onSeq?.(seq);
			}
			return step;
		},
		applied(ids: string[]) {
			if (!unavailable) applied.push(...ids);
		},
		/**
		 * Called on a timer. Sends when a send is due: every 5 seconds while
		 * there are steps to send, every 15 seconds to read messages when
		 * there are none, less often when several runs share the budget, and
		 * after the backoff when the server refused the last send as too many.
		 */
		async tick(): Promise<void> {
			if (unavailable || inFlight) return;
			const idle = !buffer.length && !applied.length;
			const shared = Math.max(1, options.runs?.() ?? 1) * RUN_STEP_SHARE_MS;
			const wait = Math.max(
				idle ? RUN_STEP_POLL_MS : RUN_STEP_FLUSH_MS,
				Math.ceil(shared / RUN_STEP_FLUSH_MS) * RUN_STEP_FLUSH_MS,
				backoffMs,
			);
			// Half a tick of slack: a timer that fires a little early still sends.
			if (now() - sentAt >= wait - RUN_STEP_FLUSH_MS / 2) await this.flush();
		},
		/**
		 * Send what is buffered and read new messages. `fresh` waits for a send
		 * already under way and then sends again, so the answer is no older than
		 * the call. Waits at most `waitMs`; the send itself goes on. False means
		 * the send failed, timed out or left buffered steps or applied ids.
		 */
		async flush(fresh = false, waitMs = 10_000): Promise<boolean> {
			if (unavailable) return true;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const work = (async () => {
				if (fresh && inFlight) await inFlight;
				return unavailable || (await round());
			})();
			const sent = await Promise.race([
				work,
				new Promise<false>((done) => {
					timer = setTimeout(() => done(false), waitMs);
				}),
			]);
			if (timer) clearTimeout(timer);
			return sent;
		},
		async endTurn(): Promise<void> {
			for (let tries = 0; tries < 3; tries++) {
				if (await this.flush(true)) return;
			}
			throw new Error(
				"Could not read follow-ups at turn end after three tries",
			);
		},
	};
}
