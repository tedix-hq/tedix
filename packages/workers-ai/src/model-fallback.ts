import {
	fallbackFailureReason,
	ModelFallbackPolicySchema,
	type ModelFallbackPolicy,
	type ModelFallbackStep,
} from "@tedix/api-contract/schemas/model-fallback";
import { CLOUDFLARE_AUTO_MODEL_REF } from "@tedix/api-contract/schemas/model-catalog";
import { IncompleteAutoRouterStreamError } from "./auto-router-stream";
import {
	ModelStreamDeadlineError,
	StreamDeadline,
	untilAborted,
	type ModelStreamDeadlines,
} from "./stream-deadlines";

/**
 * Auto Router answers with these when it rejects the request or a model in
 * its pool (for example an allowed model it does not serve). Repeating the
 * call cannot help, but the next model in the ladder can still answer.
 */
const AUTO_ROUTER_REJECTED_STATUSES = new Set([400, 404, 410, 422]);

function autoRouterRejected(ref: string, error: unknown): boolean {
	if (ref !== CLOUDFLARE_AUTO_MODEL_REF) return false;
	// readyStream only exposes this failure to fallback before model output.
	if (error instanceof IncompleteAutoRouterStreamError) return true;
	if (!error || typeof error !== "object") return false;
	const { statusCode, status } = error as {
		statusCode?: unknown;
		status?: unknown;
	};
	const code = statusCode ?? status;
	return typeof code === "number" && AUTO_ROUTER_REJECTED_STATUSES.has(code);
}

export interface ModelFallbackOptions<T> {
	primaryRef: string;
	deadlines?: ModelStreamDeadlines;
	load(): Promise<ModelFallbackPolicy>;
	resolve(ref: string): T | null | Promise<T | null>;
	/** Must durably record the transition before another provider can execute. */
	record(step: ModelFallbackStep): Promise<void>;
}

/** Apply deadlines to a pinned model without granting any fallback. */
export function withModelStreamDeadlines<T extends object>(
	primary: T,
	primaryRef: string,
	deadlines: ModelStreamDeadlines,
): T {
	return withModelFallback(primary, {
		primaryRef,
		deadlines,
		load: async () => ({ version: 1, maxTransitions: 0, ladder: {} }),
		resolve: () => null,
		record: async () => {},
	});
}

/** Availability fallback is per operation; streamed output is never replayed. */
export function withModelFallback<T extends object>(
	primary: T,
	options: ModelFallbackOptions<T>,
): T {
	let transitions = 0;
	const visited = new Set([options.primaryRef]);
	// Later calls start on the model the last call moved to, so an unavailable
	// model is not tried, and paid for in failed calls, on every call.
	let current = { model: primary, ref: options.primaryRef };
	return new Proxy(primary, {
		get(target, key, receiver) {
			const original = Reflect.get(target, key, receiver);
			if (key !== "doGenerate" && key !== "doStream")
				return typeof original === "function"
					? original.bind(target)
					: original;
			return async (...args: unknown[]) => {
				let { model, ref } = current;
				let retries = 0;
				let candidates: string[] = [];
				let policy: ModelFallbackPolicy | undefined;
				const signal = (args[0] as { abortSignal?: AbortSignal } | undefined)
					?.abortSignal;
				const endAt = Date.now() + (options.deadlines?.totalMs ?? Infinity);
				const budget = options.deadlines
					? new StreamDeadline(
							{ ...options.deadlines, firstOutputMs: Infinity },
							endAt,
							signal,
						)
					: undefined;
				const callSignal = budget?.signal ?? signal;
				const bounded = <R>(work: PromiseLike<R>): Promise<R> =>
					callSignal ? untilAborted(work, callSignal) : Promise.resolve(work);
				try {
					for (;;) {
						callSignal?.throwIfAborted();
						const deadline = options.deadlines
							? new StreamDeadline(options.deadlines, endAt, callSignal)
							: undefined;
						try {
							const dispatch = Reflect.get(model, key);
							if (typeof dispatch !== "function")
								throw new Error("Fallback adapter has no dispatch method");
							const dispatchArgs = deadline
								? [
										{ ...(args[0] as object), abortSignal: deadline.signal },
										...args.slice(1),
									]
								: args;
							deadline?.signal.throwIfAborted();
							const pending = Promise.resolve(
								Reflect.apply(dispatch, model, dispatchArgs),
							);
							const result = deadline
								? await untilAborted(pending, deadline.signal)
								: await pending;
							if (key === "doStream")
								return await readyStream(result, deadline, budget?.dispose);
							deadline?.dispose();
							budget?.dispose();
							return result;
						} catch (caught) {
							const error = deadline?.signal.aborted
								? deadline.signal.reason
								: caught;
							deadline?.dispose();
							callSignal?.throwIfAborted();
							const stalled = error instanceof ModelStreamDeadlineError;
							const rejected = autoRouterRejected(ref, error);
							const reason =
								fallbackFailureReason(error) ??
								(rejected || stalled ? "provider_unavailable" : null);
							if (!reason) throw error;
							if (
								!options.deadlines &&
								!rejected &&
								reason === "provider_unavailable" &&
								retries++ < 2
							)
								continue;
							policy ??= ModelFallbackPolicySchema.parse(
								await bounded(options.load()),
							);
							if (
								transitions >=
								Math.min(policy.maxTransitions, options.deadlines ? 1 : 5)
							)
								throw error;
							candidates = [...(policy.ladder[ref] ?? []), ...candidates];
							const next = candidates.find(
								(candidate) => !visited.has(candidate),
							);
							if (!next) throw error;
							candidates = candidates.filter((candidate) => candidate !== next);
							const resolved = await bounded(
								Promise.resolve(options.resolve(next)),
							);
							if (!resolved) throw error;
							await bounded(
								options.record({
									from: ref,
									to: next,
									reason,
									ordinal: transitions + 1,
									policyVersion: policy.version,
								}),
							);
							transitions++;
							visited.add(next);
							model = resolved;
							ref = next;
							current = { model, ref };
							retries = 0;
						}
					}
				} catch (error) {
					budget?.dispose();
					throw error;
				}
			};
		},
	});
}

/** Buffer metadata only, so an error before any output can still move down the ladder. */
async function readyStream(
	result: unknown,
	deadline?: StreamDeadline,
	onDone?: () => void,
): Promise<unknown> {
	const dispose = () => {
		deadline?.dispose();
		onDone?.();
	};
	if (
		!result ||
		typeof result !== "object" ||
		!("stream" in result) ||
		!(result.stream instanceof ReadableStream)
	) {
		dispose();
		return result;
	}
	const reader = result.stream.getReader();
	const buffered: unknown[] = [];
	let hasProgress = false;
	const read = async () => {
		const pending = reader.read();
		const part = deadline
			? await untilAborted(pending, deadline.signal)
			: await pending;
		if (!part.done) hasProgress = deadline?.progress(part.value) || hasProgress;
		else dispose();
		return part;
	};
	try {
		for (;;) {
			const part = await read();
			if (part.done) break;
			const chunk = part.value as { type?: string; error?: unknown };
			if (chunk.type === "error") throw chunk.error;
			buffered.push(part.value);
			if (
				deadline
					? hasProgress || chunk.type === "finish"
					: chunk.type !== "stream-start" && chunk.type !== "response-metadata"
			)
				break;
		}
	} catch (error) {
		deadline?.dispose();
		void reader.cancel(error).catch(() => {});
		reader.releaseLock();
		throw error;
	}
	return {
		...result,
		stream: new ReadableStream({
			async pull(controller) {
				if (buffered.length) {
					controller.enqueue(buffered.shift());
					return;
				}
				try {
					const part = await read();
					if (part.done) {
						reader.releaseLock();
						controller.close();
					} else controller.enqueue(part.value);
				} catch (error) {
					dispose();
					void reader.cancel(error).catch(() => {});
					reader.releaseLock();
					controller.error(error);
				}
			},
			async cancel(reason) {
				dispose();
				try {
					await reader.cancel(reason);
				} finally {
					reader.releaseLock();
				}
			},
		}),
	};
}
