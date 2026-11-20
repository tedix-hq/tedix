import {
	fallbackFailureReason,
	ModelFallbackPolicySchema,
	type ModelFallbackPolicy,
	type ModelFallbackStep,
} from "@tedix/api-contract/schemas/model-fallback";
import { CLOUDFLARE_AUTO_MODEL_REF } from "@tedix/api-contract/schemas/model-catalog";

/**
 * Auto Router answers with these when it rejects the request or a model in
 * its pool (for example an allowed model it does not serve). Repeating the
 * call cannot help, but the next model in the ladder can still answer.
 */
const AUTO_ROUTER_REJECTED_STATUSES = new Set([400, 404, 410, 422]);

function autoRouterRejected(ref: string, error: unknown): boolean {
	if (ref !== CLOUDFLARE_AUTO_MODEL_REF) return false;
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
						const rejected = autoRouterRejected(ref, error);
						const reason =
							fallbackFailureReason(error) ??
							(rejected ? "provider_unavailable" : null);
						if (!reason) throw error;
						if (!rejected && reason === "provider_unavailable" && retries++ < 2)
							continue;
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
						current = { model, ref };
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
