import {
	fallbackFailureReason,
	ModelFallbackPolicySchema,
	type ModelFallbackPolicy,
	type ModelFallbackStep,
} from "@tedix/api-contract/schemas/model-fallback";

export interface ModelFallbackOptions<T> {
	primaryRef: string;
	load(): Promise<ModelFallbackPolicy>;
	resolve(ref: string): T | null | Promise<T | null>;
	/** Must durably record the transition before another provider can execute. */
	record(step: ModelFallbackStep): Promise<void>;
}

/** Availability fallback is per operation; streamed output is never replayed. */
export function withModelFallback<T extends object>(
	primary: T,
	options: ModelFallbackOptions<T>,
): T {
	let transitions = 0;
	const visited = new Set([options.primaryRef]);
	return new Proxy(primary, {
		get(target, key, receiver) {
			const original = Reflect.get(target, key, receiver);
			if (key !== "doGenerate" && key !== "doStream")
				return typeof original === "function"
					? original.bind(target)
					: original;
			return async (...args: unknown[]) => {
				let model = primary;
				let ref = options.primaryRef;
				let retries = 0;
				let candidates: string[] = [];
				let policy: ModelFallbackPolicy | undefined;
				const signal = (args[0] as { abortSignal?: AbortSignal } | undefined)
					?.abortSignal;
				for (;;) {
					signal?.throwIfAborted();
					try {
						const dispatch = Reflect.get(model, key);
						if (typeof dispatch !== "function")
							throw new Error("Fallback adapter has no dispatch method");
						const result = await Reflect.apply(dispatch, model, args);
						return key === "doStream" ? await readyStream(result) : result;
					} catch (error) {
						signal?.throwIfAborted();
						const reason = fallbackFailureReason(error);
						if (!reason) throw error;
						if (reason === "provider_unavailable" && retries++ < 2) continue;
						policy ??= ModelFallbackPolicySchema.parse(await options.load());
						if (transitions >= policy.maxTransitions) throw error;
						candidates = [...(policy.ladder[ref] ?? []), ...candidates];
						const next = candidates.find(
							(candidate) => !visited.has(candidate),
						);
						if (!next) throw error;
						candidates = candidates.filter((candidate) => candidate !== next);
						const resolved = await options.resolve(next);
						if (!resolved) throw error;
						await options.record({
							from: ref,
							to: next,
							reason,
							ordinal: transitions + 1,
							policyVersion: policy.version,
						});
						transitions++;
						visited.add(next);
						model = resolved;
						ref = next;
						retries = 0;
					}
				}
			};
		},
	});
}

/** Buffer metadata only, so an error before any output can still move down the ladder. */
async function readyStream(result: unknown): Promise<unknown> {
	if (
		!result ||
		typeof result !== "object" ||
		!("stream" in result) ||
		!(result.stream instanceof ReadableStream)
	)
		return result;
	const reader = result.stream.getReader();
	const buffered: unknown[] = [];
	try {
		for (;;) {
			const part = await reader.read();
			if (part.done) break;
			const chunk = part.value as { type?: string; error?: unknown };
			if (chunk.type === "error") throw chunk.error;
			buffered.push(part.value);
			if (chunk.type !== "stream-start" && chunk.type !== "response-metadata")
				break;
		}
	} catch (error) {
		await reader.cancel().catch(() => {});
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
					const part = await reader.read();
					if (part.done) {
						reader.releaseLock();
						controller.close();
					} else controller.enqueue(part.value);
				} catch (error) {
					reader.releaseLock();
					controller.error(error);
				}
			},
			async cancel(reason) {
				try {
					await reader.cancel(reason);
				} finally {
					reader.releaseLock();
				}
			},
		}),
	};
}
