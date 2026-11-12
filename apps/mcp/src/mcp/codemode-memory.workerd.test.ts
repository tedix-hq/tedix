import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { env } from "cloudflare:workers";
import { withModelAuthoredCodeIsolation } from "@tedix/tedi-codemode-core/model-authored-code-loader";
import { describe, expect, it } from "vite-plus/test";
import { withLegacyNamespaceAliases } from "./codemode-execution";

describe("Code Mode sandbox catalog memory", () => {
	it("repeats one tool without pinning a function copy for every catalog row and alias", async () => {
		let calls = 0;
		const echo = async () => ++calls;
		const fns = Object.fromEntries(
			Array.from({ length: 20_350 }, (_, i) => [`tool_${i}`, echo]),
		);
		fns.denied = async () => {
			throw Object.assign(new Error("fictional policy denial"), {
				code: "POLICY_DENIED",
				status: 403,
			});
		};
		fns.failed = async () => {
			throw new Error("fictional provider failure");
		};
		const providers = withLegacyNamespaceAliases(
			[
				{
					name: "scope",
					fns,
					prelude: `
					let resultCopies = 0;
					const parseResponse = JSON.parse;
					JSON.parse = (...args) => {
						if (args[0].startsWith('{"result":')) resultCopies++;
						return parseResponse(...args);
					};`,
				},
			],
			new Map([["legacy", fns]]),
		);
		const executor = new DynamicWorkerExecutor({
			loader: withModelAuthoredCodeIsolation(
				(env as unknown as { LOADER: WorkerLoader }).LOADER,
			),
			globalOutbound: null,
			timeout: 5000,
		});
		const result = await executor.execute(
			`async () => {
				const pinned = () => Object.getOwnPropertyNames(scope).length +
					Object.getOwnPropertyNames(legacy).length;
				const before = pinned();
				let last;
				for (let i = 0; i < 40; i++) last = await legacy.tool_1();
				const errors = [];
				for (const api of [scope, legacy]) {
					for (const name of ["denied", "failed", "missing"]) {
						try { await api[name](); }
						catch (error) { errors.push({ message: error.message,
							code: error.code ?? null, status: error.status ?? null }); }
					}
				}
				return { before, after: pinned(), resultCopies, last, errors };
			}`,
			providers,
		);
		expect(result.error).toBeUndefined();
		expect(result.result).toEqual({
			before: 0,
			after: 0,
			resultCopies: 40,
			last: 40,
			errors: Array.from({ length: 2 }, () => [
				{
					message: "fictional policy denial",
					code: "POLICY_DENIED",
					status: 403,
				},
				{ message: "fictional provider failure", code: null, status: null },
				{ message: 'Tool "missing" not found', code: null, status: null },
			]).flat(),
		});
		expect(calls).toBe(40);
	});
});
