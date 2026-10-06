import { describe, expect, test } from "vite-plus/test";
import {
	MODEL_AUTHORED_CODE_FLAG,
	withModelAuthoredCodeIsolation,
} from "./model-authored-code-loader";

const baseCode = {
	compatibilityDate: "2026-06-11",
	compatibilityFlags: ["nodejs_compat"],
	mainModule: "index.js",
	modules: { "index.js": "export default {}" },
} satisfies WorkerLoaderWorkerCode;

describe("withModelAuthoredCodeIsolation", () => {
	test("injects the flag into anonymous Loader manifests without mutating input", () => {
		let loaded: WorkerLoaderWorkerCode | undefined;
		const loader = {
			load: (code: WorkerLoaderWorkerCode) => {
				loaded = code;
				return {} as WorkerStub;
			},
			get: () => ({}) as WorkerStub,
		} satisfies WorkerLoader;

		withModelAuthoredCodeIsolation(loader).load(baseCode);

		expect(loaded?.compatibilityFlags).toEqual([
			"nodejs_compat",
			MODEL_AUTHORED_CODE_FLAG,
		]);
		expect(baseCode.compatibilityFlags).toEqual(["nodejs_compat"]);
	});

	test("injects the flag into named Loader manifests and de-duplicates it", async () => {
		let loaded: WorkerLoaderWorkerCode | undefined;
		let capture = Promise.resolve();
		const loader = {
			load: () => ({}) as WorkerStub,
			get: (
				_name: string | null,
				getCode: () => WorkerLoaderWorkerCode | Promise<WorkerLoaderWorkerCode>,
			) => {
				capture = Promise.resolve(getCode()).then((code) => {
					loaded = code;
				});
				return {} as WorkerStub;
			},
		} satisfies WorkerLoader;

		withModelAuthoredCodeIsolation(loader).get("model-code", async () => ({
			...baseCode,
			compatibilityFlags: ["nodejs_compat", MODEL_AUTHORED_CODE_FLAG],
		}));
		await capture;

		expect(loaded?.compatibilityFlags).toEqual([
			"nodejs_compat",
			MODEL_AUTHORED_CODE_FLAG,
		]);
	});
	test("preserves explicit outbound policy, capability bindings and limits", () => {
		const capability = { fetch: async () => new Response("named capability") };
		const code = {
			...baseCode,
			globalOutbound: null,
			env: { CAPABILITY: capability },
			limits: { cpuMs: 50, subRequests: 10 },
		} satisfies WorkerLoaderWorkerCode;
		let captured: WorkerLoaderWorkerCode | undefined;
		const loader = {
			load: (value: WorkerLoaderWorkerCode) => {
				captured = value;
				return {} as WorkerStub;
			},
			get: () => ({}) as WorkerStub,
		} satisfies WorkerLoader;
		withModelAuthoredCodeIsolation(loader).load(code);
		expect(captured?.globalOutbound).toBeNull();
		expect(captured?.env).toBe(code.env);
		expect(captured?.limits).toEqual(code.limits);
		expect(captured?.compatibilityFlags).toContain(MODEL_AUTHORED_CODE_FLAG);
	});
});
