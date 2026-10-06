// Test stub for the `cloudflare:workers` module so vitest (Node) can import
// modules whose transitive deps reference Workers runtime APIs. Only the
// symbols actually referenced by code-under-test need to be present.

export class WorkerEntrypoint {
	protected env: unknown;
	protected ctx: unknown;
	constructor(ctx?: unknown, env?: unknown) {
		this.ctx = ctx;
		this.env = env;
	}
}
export class DurableObject {}
export class RpcTarget {}
// GenericTasksWorkflow (apps/mcp/src/workflows) extends this; index.ts exports
// it, so any test importing index.ts needs the base class present.
export class WorkflowEntrypoint {
	protected env: unknown;
	protected ctx: unknown;
	constructor(ctx?: unknown, env?: unknown) {
		this.ctx = ctx;
		this.env = env;
	}
}
export const env = {};

export const enteredSpans: Array<{
	name: string;
	attributes: Record<string, string>;
}> = [];

export const tracing = {
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
