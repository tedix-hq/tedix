import type { WorkAttemptStepKind } from "@tedix/api-contract/schemas/work-attempt-steps";
import { isRecord } from "@tedix/api-contract/utils/is-record";
import { scrubText } from "@tedix/context-core/trace-safety";

/** One line of a run's log, as people watching the task see it. */
export interface LaneStep {
	kind: WorkAttemptStepKind;
	text: string;
}

/** What someone sent to a run in progress. */
export interface RunMessage {
	id: string;
	kind: "follow_up" | "stop";
	body: string;
	senderType: string;
	senderId: string;
	createdAt?: string;
}

export const STEP_TEXT_LIMIT = 500;
const COMMAND_LIMIT = 300;
const STEP_BATCH = 50;
const STEP_BUFFER = 500;
export const RUN_STEP_FLUSH_MS = 5_000;

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
		const item = event.type === "item.completed" ? event.item : undefined;
		if (!isRecord(item)) return steps;
		if (item.type === "agent_message") add("message", stepText(item.text));
		if (item.type === "command_execution") {
			const command = stepText(item.command, COMMAND_LIMIT);
			if (command)
				add(
					"command",
					typeof item.exit_code === "number"
						? `${command} (exit ${item.exit_code})`
						: command,
				);
		}
		if (item.type === "file_change" && Array.isArray(item.changes))
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
			item.type === "mcp_tool_call" &&
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
 * messages people sent to the run. Sending never throws into the run: a failed
 * send keeps its steps for the next one.
 */
export function createRunStepLog(options: {
	seq?: number;
	send: SendRunSteps;
	onSeq?: (seq: number) => void;
	onMessage: (message: RunMessage) => void;
	log: (event: string, detail: string) => void;
}) {
	let seq = options.seq ?? 0;
	let buffer: Array<LaneStep & { seq: number; at: number }> = [];
	let applied: string[] = [];
	let unavailable = false;
	let failing = false;
	let inFlight: Promise<void> | undefined;
	const seen = new Set<string>();
	const sendOnce = async (): Promise<boolean> => {
		const steps = buffer.slice(0, STEP_BATCH);
		const ids = [...applied];
		let result: unknown;
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
			} else if (!failing) {
				failing = true;
				options.log("run-steps-failed", String(error).slice(0, 400));
			}
			return false;
		}
		failing = false;
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
			for (let sends = 0; sends < 10; sends++)
				if (!(await sendOnce()) || (!buffer.length && !applied.length)) return;
		})().finally(() => {
			inFlight = undefined;
		}));
	return {
		add(kind: LaneStep["kind"], text: string) {
			if (unavailable) return;
			const bounded = stepText(text);
			if (!bounded) return;
			buffer.push({ seq: seq++, at: Date.now(), kind, text: bounded });
			if (buffer.length > STEP_BUFFER) buffer.shift();
			options.onSeq?.(seq);
		},
		applied(ids: string[]) {
			if (!unavailable) applied.push(...ids);
		},
		/**
		 * Send what is buffered and read new messages. `fresh` waits for a send
		 * already under way and then sends again, so the answer is no older than
		 * the call. Waits at most `waitMs`; the send itself goes on.
		 */
		async flush(fresh = false, waitMs = 10_000): Promise<void> {
			if (unavailable) return;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const work = (async () => {
				if (fresh && inFlight) await inFlight;
				if (!unavailable) await round();
			})();
			await Promise.race([
				work,
				new Promise<void>((done) => {
					timer = setTimeout(done, waitMs);
				}),
			]);
			if (timer) clearTimeout(timer);
		},
	};
}
