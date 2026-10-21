import type { PageToolCallEvent, PageToolResult } from "./page-tools";

/**
 * Relay for page tool calls on the server side of a turn (the tedi runtime
 * and Home). The server never runs a page tool; it asks the page and waits.
 *
 * - One page tool at a time per run. Parallel calls queue behind each other,
 *   so the page never sees two actions racing on the screen the person
 *   watches, and the timeout of one call cannot fire through another.
 * - Every call gets a fresh random call id, which is also its idempotency
 *   key: the first result settles it, a repeat is refused.
 * - A result is bound to its run AND its call id; anything else matches
 *   nothing.
 * - Bounded wait, cancellable with the turn.
 */

/** A read or fill should come back quickly; a confirm waits for a person. */
export const PAGE_TOOL_TIMEOUT_MS = 30_000;
export const PAGE_TOOL_CONFIRM_TIMEOUT_MS = 180_000;

interface PendingCall {
	resolve(result: PageToolResult): void;
}

export class PageToolBroker {
	#pending = new Map<string, PendingCall>();
	#queues = new Map<string, Promise<unknown>>();
	#cancelled = new Map<string, Set<() => void>>();
	#randomId: () => string;

	constructor(randomId: () => string = () => crypto.randomUUID()) {
		this.#randomId = randomId;
	}

	/**
	 * Ask the page to run one tool and wait for its result. Serialized per
	 * run: a second call starts only after the first settled.
	 */
	request(input: {
		runId: string;
		name: string;
		args: Record<string, unknown>;
		confirm: boolean;
		emit: (event: PageToolCallEvent) => void;
		signal?: AbortSignal;
		timeoutMs?: number;
	}): Promise<PageToolResult> {
		const previous = this.#queues.get(input.runId) ?? Promise.resolve();
		const next = previous.catch(() => undefined).then(() => this.#call(input));
		const tail = next.catch(() => undefined);
		this.#queues.set(input.runId, tail);
		void tail.then(() => {
			if (this.#queues.get(input.runId) === tail)
				this.#queues.delete(input.runId);
		});
		return next;
	}

	#call(
		input: Parameters<PageToolBroker["request"]>[0],
	): Promise<PageToolResult> {
		const callId = this.#randomId();
		const key = `${input.runId}\u0000${callId}`;
		const timeoutMs =
			input.timeoutMs ??
			(input.confirm ? PAGE_TOOL_CONFIRM_TIMEOUT_MS : PAGE_TOOL_TIMEOUT_MS);
		return new Promise<PageToolResult>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const cancelers =
				this.#cancelled.get(input.runId) ?? new Set<() => void>();
			this.#cancelled.set(input.runId, cancelers);
			const settle = (result: PageToolResult) => {
				if (!this.#pending.has(key)) return;
				this.#pending.delete(key);
				if (timer) clearTimeout(timer);
				input.signal?.removeEventListener("abort", onAbort);
				cancelers.delete(onCancel);
				if (!cancelers.size) this.#cancelled.delete(input.runId);
				resolve(result);
			};
			const onAbort = () =>
				settle({ ok: false, content: "The turn was cancelled." });
			const onCancel = onAbort;
			this.#pending.set(key, { resolve: settle });
			cancelers.add(onCancel);
			if (input.signal?.aborted) return onAbort();
			input.signal?.addEventListener("abort", onAbort, { once: true });
			timer = setTimeout(
				() =>
					settle({
						ok: false,
						content: input.confirm
							? "The person did not confirm in time. Nothing was submitted."
							: "The page did not answer in time.",
					}),
				timeoutMs,
			);
			try {
				input.emit({
					kind: "page_tool_call",
					callId,
					name: input.name,
					args: input.args,
					confirm: input.confirm,
				});
			} catch {
				settle({ ok: false, content: "The page could not be reached." });
			}
		});
	}

	/** Settle one call. False for an unknown, foreign or already settled id. */
	resolve(runId: string, callId: string, result: PageToolResult): boolean {
		const pending = this.#pending.get(`${runId}\u0000${callId}`);
		if (!pending) return false;
		pending.resolve(result);
		return true;
	}

	/** Fail every open call of a run, as cancel and turn end do. */
	cancelRun(runId: string): void {
		for (const cancel of [...(this.#cancelled.get(runId) ?? [])]) cancel();
	}

	/** Open calls, for tests and diagnostics. */
	pendingCount(): number {
		return this.#pending.size;
	}
}
