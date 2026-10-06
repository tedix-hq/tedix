import { env } from "cloudflare:workers";
import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { withModelAuthoredCodeIsolation } from "@tedix/tedi-codemode-core/model-authored-code-loader";
import { describe, expect, it } from "vite-plus/test";

// Exercise the same native SDK executor and hardened Loader used by this surface.
function executor() {
	return new DynamicWorkerExecutor({
		loader: withModelAuthoredCodeIsolation(
			(env as unknown as { LOADER: WorkerLoader }).LOADER,
		),
		timeout: 5000,
		globalOutbound: null,
	});
}
describe("Code Mode native isolation", () => {
	it("allows only explicitly wired RPC without platform secrets", async () => {
		const calls: unknown[] = [];
		const result = await executor().execute(
			"async () => ({ allowed: await scope.echo({ marker: 'named-rpc' }), ambientEnv: typeof env, token: typeof PLATFORM_SERVICE_TOKEN })",
			[
				{
					name: "scope",
					fns: {
						echo: async (...args) => {
							calls.push(args);
							return "named-rpc-ok";
						},
					},
				},
			],
		);
		expect(result.error).toBeUndefined();
		expect(result.result).toEqual({
			allowed: "named-rpc-ok",
			ambientEnv: "undefined",
			token: "undefined",
		});
		expect(calls).toEqual([[{ marker: "named-rpc" }]]);
	});
	it("blocks ambient fetch in the actual isolate", async () => {
		const result = await executor().execute(
			"async () => await fetch('https://example.com/ambient-forbidden')",
			[],
		);
		expect(result.error).toBeTruthy();
		expect(result.result).toBeUndefined();
	});
	it("makes imported Worker env unavailable", async () => {
		const result = await executor().execute(
			"async () => { const runtime = await import('cloudflare:workers'); return { keys: Object.keys(runtime.env ?? {}), secret: runtime.env?.PLATFORM_SERVICE_TOKEN ?? null };  }",
			[],
		);
		expect(result.error).toBeUndefined();
		expect(result.result).toEqual({ keys: [], secret: null });
	});
});
