/**
 * Test stub for the `cloudflare:workers` module.
 *
 * `apps/api`'s unit tests run under plain Node, where this Worker-runtime
 * module does not resolve. Anything reaching it here does so transitively:
 * `agents/observability/ai` — the `wrapAISDK` span wrapper behind
 * `src/lib/traced-ai.ts` — reads `tracing` to open GenAI spans, so a node test
 * that imports a kernel router loads it.
 *
 * `tracing` is deliberately an EMPTY object rather than a fake span API. The
 * wrapper selects its runtime with `typeof candidate?.startActiveSpan ===
 * "function"` and otherwise uses its own no-op tracer, so an inert value makes
 * the wrapper pass every call straight through to the real AI SDK. A stub that
 * imitated the span API would instead have tests exercising a fake tracer.
 * Span emission is a Worker-runtime concern; these tests assert model calls.
 *
 * Only the symbols actually referenced by code-under-test need to be present.
 */

export const enteredSpans: Array<{
	name: string;
	attributes: Record<string, string>;
}> = [];

export const tracing = {
	// The API's oRPC interceptor uses enterSpan. Leave startActiveSpan absent so
	// wrapAISDK still selects its own no-op tracer in Node tests.
	enterSpan: async <T>(
		name: string,
		callback: (span: {
			setAttribute: (key: string, value: string) => void;
		}) => T | Promise<T>,
	): Promise<T> => {
		const attributes: Record<string, string> = {};
		enteredSpans.push({ name, attributes });
		return callback({
			setAttribute(key, value) {
				attributes[key] = value;
			},
		});
	},
};

export class DurableObject {}
export class RpcTarget {}
export class WorkerEntrypoint {}
export class WorkflowEntrypoint {
	protected env: unknown;
	protected ctx: unknown;
	constructor(ctx?: unknown, env?: unknown) {
		this.ctx = ctx;
		this.env = env;
	}
}
export const env = {};
