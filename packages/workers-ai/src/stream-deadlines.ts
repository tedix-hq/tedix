/** One model operation, including fallback, shares this absolute budget. */
export interface ModelStreamDeadlines {
	firstOutputMs: number;
	idleMs: number;
	totalMs: number;
}

export class ModelStreamDeadlineError extends Error {
	constructor(readonly phase: "first_output" | "idle" | "total") {
		super(`Model stream deadline exceeded (${phase})`);
		this.name = "ModelStreamDeadlineError";
	}
}

/** Reject even when a transport ignores cancellation; always detach the listener. */
export async function untilAborted<T>(
	work: PromiseLike<T>,
	signal: AbortSignal,
): Promise<T> {
	if (signal.aborted) {
		void Promise.resolve(work).catch(() => {});
		throw signal.reason;
	}
	let onAbort!: () => void;
	try {
		return await Promise.race([
			work,
			new Promise<never>((_resolve, reject) => {
				onAbort = () => reject(signal.reason);
				signal.addEventListener("abort", onAbort, { once: true });
			}),
		]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

export class StreamDeadline {
	private readonly controller = new AbortController();
	readonly signal: AbortSignal;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private progressAt: number | null = null;
	private readonly firstAt: number;
	constructor(
		private readonly limits: ModelStreamDeadlines,
		private readonly endAt: number,
		parent?: AbortSignal,
	) {
		this.firstAt = Date.now() + limits.firstOutputMs;
		this.signal = parent
			? AbortSignal.any([parent, this.controller.signal])
			: this.controller.signal;
		this.signal.addEventListener("abort", this.dispose, { once: true });
		this.schedule();
	}
	progress(part: unknown): boolean {
		const chunk = part as { type?: string; delta?: string };
		if (
			((chunk.type === "text-delta" ||
				chunk.type === "reasoning-delta" ||
				chunk.type === "tool-input-delta") &&
				!!chunk.delta) ||
			chunk.type === "tool-call" ||
			chunk.type === "tool-result" ||
			chunk.type === "tool-input-start"
		) {
			this.progressAt = Date.now();
			this.schedule();
			return true;
		}
		return false;
	}
	private schedule(): void {
		clearTimeout(this.timer);
		if (this.signal.aborted) return;
		const progressEnd =
			this.progressAt === null
				? this.firstAt
				: this.progressAt + this.limits.idleMs;
		const phase =
			this.endAt <= progressEnd
				? "total"
				: this.progressAt === null
					? "first_output"
					: "idle";
		const remaining = Math.min(this.endAt, progressEnd) - Date.now();
		if (remaining <= 0)
			this.controller.abort(new ModelStreamDeadlineError(phase));
		else
			this.timer = setTimeout(
				() => this.controller.abort(new ModelStreamDeadlineError(phase)),
				remaining,
			);
	}
	dispose = (): void => {
		clearTimeout(this.timer);
		this.signal.removeEventListener("abort", this.dispose);
	};
}
