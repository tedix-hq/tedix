import { describe, expect, it, vi } from "vite-plus/test";
import {
	runStatelessCodeMode,
	wrapStatelessCodeModeSource,
} from "./run-stateless-code";

describe("wrapStatelessCodeModeSource", () => {
	it("wraps user code as an async function expression", () => {
		const wrapped = wrapStatelessCodeModeSource("async () => 42;");
		expect(wrapped).toContain("const __tedixUserCode = (async () => 42)");
		expect(wrapped).toContain("__tedixNormalizeDiscoveryArray");
	});
});

describe("runStatelessCodeMode", () => {
	it.each([
		'async () => await scope.echo({"marker":"request"})',
		'async () => { return await scope.echo({"marker":"request"}); };',
		"async () => scope.echo({ marker: 'request', })",
	])(
		"dispatches a literal call without constructing a worker: %s",
		async (code) => {
			const execute = vi.fn();
			const echo = vi.fn(async (value) => value);
			const result = await runStatelessCodeMode({
				code,
				executor: { execute } as never,
				timeoutMs: 1000,
				providers: [{ name: "scope", fns: { echo } }],
			});
			expect(result).toEqual({ result: { marker: "request" }, logs: [] });
			expect(echo).toHaveBeenCalledExactlyOnceWith({ marker: "request" });
			expect(execute).not.toHaveBeenCalled();
		},
	);

	it.each([
		"async () => { return\n scope.echo({}); }",
		"async\n () => scope.echo({})",
		'async () => scope.echo({"__proto__":{}})',
		"async () => scope.echo((globalThis.secret = 1))",
		"async () => { return scope.echo({}); scope.echo({}); }",
		'async () => scope.echo({"a":1}, scope.echo({}))',
		"async () => scope.echo({ [scope.echo()]: 1 })",
		"async () => scope.echo({ get value() { return scope.echo(); } })",
		"async () => scope.echo({ ...scope.echo() })",
		"async () => scope.echo({ __proto__: {} })",
		"async () => scope.echo(010)",
		"async () => scope.echo('\\1')",
	])(
		"leaves JavaScript expressions and statements in the sandbox: %s",
		async (code) => {
			const execute = vi.fn(async () => ({ result: "sandbox" }));
			const echo = vi.fn();
			const result = await runStatelessCodeMode({
				code,
				executor: { execute } as never,
				timeoutMs: 1000,
				providers: [{ name: "scope", fns: { echo } }],
			});
			expect(result.result).toBe("sandbox");
			expect(echo).not.toHaveBeenCalled();
			expect(execute).toHaveBeenCalledOnce();
		},
	);

	it("decodes nested JavaScript data literals without a worker", async () => {
		const execute = vi.fn();
		const echo = vi.fn(async (value) => value);
		const result = await runStatelessCodeMode({
			code: "async () => scope.echo({ values: [null, true, false, -1.5, 0xff, 'line\\nnext',], nested: { constructor: 'data' }, duplicate: 1, duplicate: 2 })",
			executor: { execute } as never,
			timeoutMs: 1000,
			providers: [{ name: "scope", fns: { echo } }],
		});
		expect(result.result).toEqual({
			values: [null, true, false, -1.5, 255, "line\nnext"],
			nested: { constructor: "data" },
			duplicate: 2,
		});
		expect(echo).toHaveBeenCalledOnce();
		expect(execute).not.toHaveBeenCalled();
	});

	it("keeps request providers separate and preserves binary serialization", async () => {
		const execute = vi.fn();
		const run = (marker: string) =>
			runStatelessCodeMode({
				code: "async () => scope.echo()",
				executor: { execute } as never,
				timeoutMs: 1000,
				providers: [
					{
						name: "scope",
						fns: {
							echo: async () => ({ marker, bytes: new Uint8Array([1, 2]) }),
						},
					},
				],
			});
		const results = await Promise.all([run("alpha"), run("beta")]);
		expect(results.map((value) => value.result)).toEqual([
			{ marker: "alpha", bytes: new Uint8Array([1, 2]) },
			{ marker: "beta", bytes: new Uint8Array([1, 2]) },
		]);
		expect(execute).not.toHaveBeenCalled();
	});

	it("returns authorization failures without retrying in a worker", async () => {
		const execute = vi.fn();
		const denied = vi.fn(async () => {
			throw new Error("scope denied");
		});
		const result = await runStatelessCodeMode({
			code: "async () => scope.denied()",
			executor: { execute } as never,
			timeoutMs: 1000,
			providers: [{ name: "scope", fns: { denied } }],
		});
		expect(result.error).toBe("scope denied");
		expect(denied).toHaveBeenCalledOnce();
		expect(execute).not.toHaveBeenCalled();
	});

	it("times out a pending direct call without dispatching twice", async () => {
		vi.useFakeTimers();
		const execute = vi.fn();
		let release!: (value: unknown) => void;
		const slow = vi.fn(
			() =>
				new Promise((resolve) => {
					release = resolve;
				}),
		);
		try {
			const pending = runStatelessCodeMode({
				code: "async () => scope.slow()",
				executor: { execute } as never,
				timeoutMs: 1000,
				providers: [{ name: "scope", fns: { slow } }],
			});
			await vi.advanceTimersByTimeAsync(1000);
			expect((await pending).error).toBe("Execution timed out");
			expect(slow).toHaveBeenCalledOnce();
			expect(execute).not.toHaveBeenCalled();
		} finally {
			release(undefined);
			vi.useRealTimers();
		}
	});

	it("keeps sandbox preludes and ambiguous sanitized names on the executor", async () => {
		for (const provider of [
			{
				name: "scope",
				fns: { echo: vi.fn() },
				prelude: "scope.echo = () => 42;",
			},
			{ name: "scope", fns: { "e-cho": vi.fn(), e_cho: vi.fn() } },
		]) {
			const execute = vi.fn(async () => ({ result: "sandbox" }));
			await runStatelessCodeMode({
				code: `async () => scope.${provider.prelude ? "echo" : "e_cho"}()`,
				executor: { execute } as never,
				timeoutMs: 1000,
				providers: [provider],
			});
			expect(execute).toHaveBeenCalledOnce();
			for (const fn of Object.values(provider.fns))
				expect(fn).not.toHaveBeenCalled();
		}
	});

	it("keeps discover.search sliceable when the execution boundary returns an object", async () => {
		const executor = {
			execute: async (
				code: string,
				providers: Array<{
					name: string;
					fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
				}>,
			) => {
				const provider = providers.find((entry) => entry.name === "discover");
				if (!provider) throw new Error("discover provider missing");
				const discover = { search: provider.fns.search };
				const fn = Function("discover", `return (${code});`)(discover);
				return { result: await fn(), logs: [] };
			},
		};

		const result = await runStatelessCodeMode({
			code: `async () => {
				const tools = await discover.search({ query: "workstation" });
				return {
					firstCallable: tools.slice(0, 1)[0]?.callable,
					resultsIsArray: Array.isArray(tools.results),
					metaSource: tools._meta?.source,
				};
			}`,
			executor: executor as never,
			providers: [
				{
					name: "discover",
					fns: {
						search: async () => ({
							0: { callable: "cto.read_execution" },
							results: [{ callable: "cto.read_execution" }],
							_meta: { source: "objectified-boundary" },
						}),
					},
				},
			] as never,
		});

		expect(result.error).toBeUndefined();
		expect(result.result).toEqual({
			firstCallable: "cto.read_execution",
			resultsIsArray: true,
			metaSource: "objectified-boundary",
		});
	});

	it("keeps discover.search sliceable when results[] is also objectified", async () => {
		const executor = {
			execute: async (
				code: string,
				providers: Array<{
					name: string;
					fns: Record<string, (...args: unknown[]) => Promise<unknown>>;
				}>,
			) => {
				const provider = providers.find((entry) => entry.name === "discover");
				if (!provider) throw new Error("discover provider missing");
				const discover = { search: provider.fns.search };
				const fn = Function("discover", `return (${code});`)(discover);
				return { result: await fn(), logs: [] };
			},
		};

		const result = await runStatelessCodeMode({
			code: `async () => {
				const tools = await discover.search({ query: "workstation" });
				return {
					firstCallable: tools.slice(0, 1)[0]?.callable,
					resultsFirstCallable: tools.results.slice(0, 1)[0]?.callable,
					resultsIsArray: Array.isArray(tools.results),
					metaSource: tools._meta?.source,
				};
			}`,
			executor: executor as never,
			providers: [
				{
					name: "discover",
					fns: {
						search: async () => ({
							results: {
								0: { callable: "cto.read_execution" },
								length: 1,
							},
							_meta: { source: "nested-objectified-boundary" },
						}),
					},
				},
			] as never,
		});

		expect(result.error).toBeUndefined();
		expect(result.result).toEqual({
			firstCallable: "cto.read_execution",
			resultsFirstCallable: "cto.read_execution",
			resultsIsArray: true,
			metaSource: "nested-objectified-boundary",
		});
	});
});
