/**
 * Bun test preload: provide a virtual `cloudflare:workers` module so
 * plain-bun unit tests can import packages whose dist references the
 * workerd-only builtins at module scope (`@cloudflare/computer`, and the
 * Agents SDK that `do.ts` extends).
 * Only the names those bundles touch at import time are stubbed;
 * anything runtime-only stays unimplemented on purpose.
 */
import { plugin } from "bun";

class TestRpcTarget {}
class TestRpcStub {}
class TestDurableObject {
	constructor(
		readonly ctx: unknown,
		readonly env: unknown,
	) {}
}
class TestWorkerEntrypoint {}
class TestWorkflowEntrypoint {}

plugin({
	name: "cloudflare-workers-stub",
	setup(build) {
		build.module("cloudflare:workers", () => ({
			exports: {
				RpcTarget: TestRpcTarget,
				RpcStub: TestRpcStub,
				DurableObject: TestDurableObject,
				WorkerEntrypoint: TestWorkerEntrypoint,
				WorkflowEntrypoint: TestWorkflowEntrypoint,
				env: {},
				exports: {},
				tracing: {
					enterSpan: (
						_name: string,
						callback: (span: { setAttribute: () => void }) => unknown,
					) => callback({ setAttribute: () => {} }),
				},
				waitUntil: (_p: Promise<unknown>) => {},
			},
			loader: "object",
		}));
		build.module("cloudflare:email", () => ({
			exports: { EmailMessage: class TestEmailMessage {} },
			loader: "object",
		}));
		build.module("cloudflare:workflows", () => ({
			exports: { NonRetryableError: class NonRetryableError extends Error {} },
			loader: "object",
		}));
		build.module("cloudflare:sockets", () => ({
			exports: {
				connect: () => {
					throw new Error("cloudflare:sockets is unavailable in bun tests");
				},
			},
			loader: "object",
		}));
	},
});
