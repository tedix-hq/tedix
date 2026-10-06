import { describe, expect, it } from "vite-plus/test";
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
