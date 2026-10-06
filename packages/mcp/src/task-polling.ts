/**
 * The one client-side driver for the MCP 2026-07-28 Tasks extension
 * (`tasks/get`, `tasks/update`, `tasks/cancel`). The SDK `Client` has no Tasks
 * API for this wire era (its `TaskSchema` family is the deprecated 2025-11-25
 * vocabulary), so every Tedix-owned client — the stateless client loop
 * (`packages/mcp-client-core`), the `tedix` CLI, and the skill-runtime bridge
 * — polls through this module. It is runtime-neutral: the caller injects the
 * JSON-RPC `request` function (fetch, SDK transport, or a service binding), so
 * it runs unchanged under Bun and Workers.
 *
 * Policy (identical for every caller; the numbers are options, the rules are
 * not):
 *
 * - **Backoff.** Wait the server's `pollIntervalMs` hint, clamped to
 *   `[minIntervalMs, maxIntervalMs]`; without a hint wait `defaultIntervalMs`.
 *   Polling is bounded by BOTH a wall-clock `timeoutMs` and `maxAttempts`;
 *   exhausting either yields a `timeout` outcome carrying the last state.
 * - **Terminal states.** `completed` → `completed` with the task's `result`
 *   (the state itself when the server sent no result record). `failed` and
 *   `cancelled` are returned as outcomes, never thrown: the caller decides how
 *   its surface reports them. Any other status — including an unknown one from
 *   a newer peer — is non-terminal and waits like `working`.
 * - **Not found.** A task-not-found error (`-32602` "Task not found") is
 *   terminal and propagates, EXCEPT inside `notFoundGraceMs` from the start of
 *   polling, where it is treated as `working` (a server whose task record is
 *   projected asynchronously from the originating call). Default grace is 0.
 * - **Cancellation.** When the caller's signal aborts while the task is still
 *   non-terminal — at a poll boundary or mid-request — polling stops, a
 *   best-effort `tasks/cancel` is sent without the aborted signal, and the
 *   abort is rethrown (`taskAbortError`). A task already terminal when the
 *   abort lands returns normally and is never cancelled. Cancel failures are
 *   reported to `onCancelError` and swallowed.
 * - **input_required.** Input request ids are lifetime-unique, so only newly
 *   observed ids are offered to `resolveInput` (re-running a resolver could
 *   duplicate a human prompt or a non-idempotent answer). Answers are filtered
 *   to those pending ids, sent with one `tasks/update`, and the task is
 *   re-polled immediately. When every pending id was already answered, wait one
 *   interval. When there is no resolver, or it declines (returns null/empty),
 *   the outcome is `input_required` with the unanswered requests.
 * - **Validation.** `strict` parses `tasks/get` / `tasks/update` /
 *   `tasks/cancel` with the canonical `@tedix/api-contract/schemas/mcp-tasks`
 *   schemas and throws on drift (clients that talk only to a Tedix gateway).
 *   Lenient mode (default, for arbitrary upstream servers) requires only a
 *   JSON object. States pushed by a subscription are always read leniently.
 */
import {
	McpCancelTaskResultSchema,
	McpGetTaskResultSchema,
	type McpGetTaskResult,
	McpUpdateTaskResultSchema,
} from "@tedix/api-contract/schemas/mcp-tasks";

export type McpTaskMethod = "tasks/get" | "tasks/update" | "tasks/cancel";

/** Send one JSON-RPC request and return its `result`; throw on a JSON-RPC error. */
export type McpTaskRequest = (
	method: McpTaskMethod,
	params: Record<string, unknown>,
	signal?: AbortSignal,
) => Promise<unknown>;

export type McpTaskStateRecord = Record<string, unknown>;

export interface McpTaskPollPolicy {
	/** Wall-clock polling budget. Default 180 000 ms. */
	timeoutMs?: number;
	/** Maximum `tasks/get` rounds (including input rounds). Default unbounded. */
	maxAttempts?: number;
	/** Wait used when the server sends no `pollIntervalMs`. Default 500 ms. */
	defaultIntervalMs?: number;
	/** Lower clamp on any wait. Default 0 ms. */
	minIntervalMs?: number;
	/** Upper clamp on any wait. Default 2 000 ms. */
	maxIntervalMs?: number;
	/** Window from poll start in which task-not-found means "not yet visible". Default 0. */
	notFoundGraceMs?: number;
}

export const DEFAULT_MCP_TASK_POLL_POLICY: Required<McpTaskPollPolicy> = {
	timeoutMs: 180_000,
	maxAttempts: Number.POSITIVE_INFINITY,
	defaultIntervalMs: 500,
	minIntervalMs: 0,
	maxIntervalMs: 2_000,
	notFoundGraceMs: 0,
};

export interface McpTaskInputResolverInput {
	taskId: string;
	inputRequests: Record<string, unknown>;
}

export type McpTaskInputResolver = (
	input: McpTaskInputResolverInput,
) =>
	| Promise<Record<string, unknown> | null | undefined>
	| Record<string, unknown>
	| null
	| undefined;

/** Optional push source (e.g. a `subscriptions/listen` stream). */
export interface McpTaskPushSource {
	/** Resolve the next pushed task state, or null after `timeoutMs` / on close. */
	next(timeoutMs: number): Promise<McpTaskStateRecord | null>;
}

export interface PollMcpTaskOptions extends McpTaskPollPolicy {
	taskId: string;
	request: McpTaskRequest;
	signal?: AbortSignal;
	strict?: boolean;
	resolveInput?: McpTaskInputResolver;
	push?: McpTaskPushSource | null;
	onCancelError?: (error: unknown) => void;
	/** Test seams. */
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	now?: () => number;
}

export type McpTaskPollOutcome =
	| {
			status: "completed";
			state: McpTaskStateRecord;
			result: Record<string, unknown>;
	  }
	| { status: "failed" | "cancelled"; state: McpTaskStateRecord }
	| {
			status: "input_required";
			state: McpTaskStateRecord;
			inputRequests: Record<string, unknown>;
	  }
	| { status: "timeout"; state: McpTaskStateRecord | null };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (isRecord(error) && typeof error.message === "string") {
		return error.message;
	}
	return typeof error === "string" ? error : "";
}

/**
 * Is this a task-not-found failure? Matches the canonical server error
 * (`McpTaskError.notFound`: code `-32602`, message "Task not found") whether it
 * arrives as a structured error, a JSON-RPC error record, or an Error whose
 * message embeds it; walks `cause`. A bare `-32602` (generic Invalid Params) or
 * "Method not found" is NOT a missing task.
 */
export function isMcpTaskNotFoundError(error: unknown): boolean {
	for (let current = error, depth = 0; current && depth < 5; depth++) {
		const message = errorMessage(current);
		if (/\btask not found\b/i.test(message)) return true;
		if (
			isRecord(current) &&
			current.code === -32_602 &&
			/\bnot found\b/i.test(message) &&
			!/\bmethod not found\b/i.test(message)
		) {
			return true;
		}
		current =
			isRecord(current) || current instanceof Error
				? (current as { cause?: unknown }).cause
				: undefined;
	}
	return false;
}

/**
 * Rejection for a caller abort during polling: the signal's own `reason` when it
 * is an Error (dispatchers pass a descriptive one), otherwise an AbortError.
 */
export function taskAbortError(signal: AbortSignal, taskId: string): Error {
	if (signal.reason instanceof Error) return signal.reason;
	return new DOMException(
		`MCP task ${taskId} polling aborted by caller`,
		"AbortError",
	);
}

export class McpTaskResponseError extends Error {
	readonly issues: unknown;
	constructor(method: string, issues: unknown) {
		super(
			`MCP ${method} returned an invalid Tasks extension response: ${JSON.stringify(issues)}`,
		);
		this.name = "McpTaskResponseError";
		this.issues = issues;
	}
}

/** Parse a `tasks/get` result (strict: canonical schema; lenient: any object). */
export function parseMcpTaskState(
	raw: unknown,
	options: { strict: true },
): McpGetTaskResult;
export function parseMcpTaskState(
	raw: unknown,
	options?: { strict?: boolean },
): McpTaskStateRecord;
export function parseMcpTaskState(
	raw: unknown,
	options: { strict?: boolean } = {},
): McpTaskStateRecord {
	if (options.strict) {
		const parsed = McpGetTaskResultSchema.safeParse(raw);
		if (!parsed.success) {
			throw new McpTaskResponseError("tasks/get", parsed.error.issues);
		}
		return parsed.data as McpTaskStateRecord;
	}
	if (!isRecord(raw)) {
		throw new McpTaskResponseError("tasks/get", "expected a task object");
	}
	return raw;
}

/** Validate a `tasks/update` / `tasks/cancel` acknowledgement in strict mode. */
export function assertMcpTaskAck(
	method: "tasks/update" | "tasks/cancel",
	raw: unknown,
	options: { strict?: boolean } = {},
): void {
	if (!options.strict) return;
	const schema =
		method === "tasks/update"
			? McpUpdateTaskResultSchema
			: McpCancelTaskResultSchema;
	const parsed = schema.safeParse(raw);
	if (!parsed.success) {
		throw new McpTaskResponseError(method, parsed.error.issues);
	}
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	if (ms <= 0 || signal?.aborted) return Promise.resolve();
	return new Promise((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve();
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Poll one task to a terminal state (or `input_required` / `timeout`) under
 * the module policy above. Throws on transport errors, task-not-found outside
 * the grace window, strict-schema drift, and caller aborts.
 */
export async function pollMcpTask(
	options: PollMcpTaskOptions,
): Promise<McpTaskPollOutcome> {
	const policy = { ...DEFAULT_MCP_TASK_POLL_POLICY };
	for (const key of Object.keys(policy) as (keyof McpTaskPollPolicy)[]) {
		const value = options[key];
		if (typeof value === "number" && !Number.isNaN(value)) policy[key] = value;
	}
	const { taskId, request, signal, strict, push } = options;
	const sleep = options.sleep ?? abortableSleep;
	const now = options.now ?? Date.now;
	const onCancelError =
		options.onCancelError ??
		((error: unknown) =>
			console.warn(
				`[mcp-tasks] best-effort tasks/cancel failed for task ${taskId}:`,
				errorMessage(error) || error,
			));
	const clamp = (ms: number) =>
		Math.min(Math.max(ms, policy.minIntervalMs), policy.maxIntervalMs);
	const intervalFor = (state: McpTaskStateRecord | null) =>
		clamp(
			typeof state?.pollIntervalMs === "number"
				? state.pollIntervalMs
				: policy.defaultIntervalMs,
		);

	const startedAt = now();
	const deadline = startedAt + policy.timeoutMs;
	const answered = new Set<string>();
	let lastState: McpTaskStateRecord | null = null;
	let pushed: McpTaskStateRecord | null = null;

	const wait = async (ms: number) => {
		if (push) {
			pushed = (await push.next(ms)) ?? null;
			return;
		}
		await sleep(ms, signal);
	};

	try {
		for (
			let attempt = 0;
			attempt < policy.maxAttempts && now() < deadline;
			attempt++
		) {
			if (signal?.aborted) throw taskAbortError(signal, taskId);

			let state: McpTaskStateRecord | null =
				pushed ?? (push ? await push.next(0) : null);
			pushed = null;
			if (state && !isRecord(state)) state = null;
			if (!state) {
				try {
					state = parseMcpTaskState(
						await request("tasks/get", { taskId }, signal),
						{ strict },
					);
				} catch (error) {
					if (
						!signal?.aborted &&
						now() - startedAt < policy.notFoundGraceMs &&
						isMcpTaskNotFoundError(error)
					) {
						await wait(intervalFor(null));
						continue;
					}
					throw error;
				}
			}
			lastState = state;
			const status = typeof state.status === "string" ? state.status : "";

			if (status === "completed") {
				return {
					status,
					state,
					result: isRecord(state.result) ? state.result : state,
				};
			}
			if (status === "failed" || status === "cancelled") {
				return { status, state };
			}
			if (status === "input_required") {
				const all = isRecord(state.inputRequests) ? state.inputRequests : {};
				const pending = Object.fromEntries(
					Object.entries(all).filter(([id]) => !answered.has(id)),
				);
				if (Object.keys(pending).length === 0) {
					await wait(intervalFor(state));
					continue;
				}
				const responses = options.resolveInput
					? await options.resolveInput({ taskId, inputRequests: pending })
					: null;
				const answers = Object.fromEntries(
					Object.entries(responses ?? {}).filter(([id]) => id in pending),
				);
				if (Object.keys(answers).length === 0) {
					return { status, state, inputRequests: pending };
				}
				assertMcpTaskAck(
					"tasks/update",
					await request(
						"tasks/update",
						{ taskId, inputResponses: answers },
						signal,
					),
					{ strict },
				);
				for (const id of Object.keys(answers)) answered.add(id);
				continue; // re-poll immediately after answering
			}

			await wait(intervalFor(state));
		}
		if (signal?.aborted) throw taskAbortError(signal, taskId);
		return { status: "timeout", state: lastState };
	} catch (error) {
		if (!signal?.aborted) throw error;
		try {
			await request("tasks/cancel", { taskId });
		} catch (cancelError) {
			onCancelError(cancelError);
		}
		throw taskAbortError(signal, taskId);
	}
}
