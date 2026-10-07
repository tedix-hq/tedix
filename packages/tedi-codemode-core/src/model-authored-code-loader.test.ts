import { DynamicWorkerExecutor } from "@cloudflare/codemode";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
	MODEL_AUTHORED_CODE_FLAG,
	withDynamicWorkerLoaderDiagnostics,
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

describe("test-only named manifest identity before cached callbacks", () => {
	test("refuses changed code and security fields even when cached get skips getCode", () => {
		let callbacks = 0,
			gets = 0;
		const original = {
			...baseCode,
			globalOutbound: null,
			limits: { cpuMs: 50 },
		};
		const identity = JSON.stringify(original);
		const native = {
			load: () => ({}) as WorkerStub,
			get: (
				_name: string | null,
				_getCode: () =>
					| WorkerLoaderWorkerCode
					| Promise<WorkerLoaderWorkerCode>,
			) => {
				gets++;
				return {} as WorkerStub;
			},
		} satisfies WorkerLoader;
		const fixed = (code: WorkerLoaderWorkerCode) => {
			if (JSON.stringify(code) !== identity)
				throw new Error("named manifest changed");
			return withModelAuthoredCodeIsolation(native).get(
				"fictional-same-name",
				() => {
					callbacks++;
					return code;
				},
			);
		};
		fixed(original);
		fixed(original);
		for (const changed of [
			{
				...original,
				modules: { "index.js": "export default { changed: true }" },
			},
			{ ...original, compatibilityDate: "2026-07-01" },
			{ ...original, mainModule: "other.js" },
			{ ...original, compatibilityFlags: [] },
			{ ...original, globalOutbound: undefined },
			{ ...original, env: { EXTRA: "fictional" } },
			{ ...original, limits: { cpuMs: 51 } },
		])
			expect(() => fixed(changed)).toThrow("named manifest changed");
		expect(gets).toBe(2);
		expect(callbacks).toBe(0);
	});
});

const host = {
	surface: "gateway_model_code",
	reason: "gateway_model_authored_invocation",
} as const;
const hostPairs = [
	host,
	{ surface: "stored_tool_code", reason: "stored_tool_authored_invocation" },
	{
		surface: "tedi_stateless_mcp_code",
		reason: "tedi_stateless_authored_invocation",
	},
	{ surface: "tedi_durable_code", reason: "tedi_durable_authored_invocation" },
] as const;
const events = (spy: ReturnType<typeof vi.spyOn>) =>
	spy.mock.calls.map(([s]) => JSON.parse(String(s)));
afterEach(() => vi.restoreAllMocks());

describe("trusted native loader-call diagnostics", () => {
	test.each(hostPairs)(
		"fixed host pair and synchronous stub identity: $surface",
		(pair) => {
			const spy = vi.spyOn(console, "log").mockImplementation(() => {});
			const stub = {} as WorkerStub;
			const native = {
				load: vi.fn(() => stub),
				get: vi.fn(() => stub),
			} as WorkerLoader;
			const wrapped = withModelAuthoredCodeIsolation(native, pair);
			expect(wrapped.load(baseCode)).toBe(stub);
			expect(events(spy)).toEqual(
				["attempted", "returned"].map((phase) => ({
					event: "tedix.dynamic_worker.loader_call",
					version: 1,
					surface: pair.surface,
					reason: pair.reason,
					method: "load",
					identity: "anonymous",
					phase,
				})),
			);
			expect(Object.keys(events(spy)[0])).toEqual([
				"event",
				"version",
				"surface",
				"reason",
				"method",
				"identity",
				"phase",
			]);
		},
	);
	test("hardening failure precedes attempts; native throws rethrow the original", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const failure = new Error("private manifest or native error");
		const load = vi.fn(() => {
			throw failure;
		});
		const wrapped = withModelAuthoredCodeIsolation(
			{ load, get: vi.fn() } as WorkerLoader,
			host,
		);
		const bad = {
			...baseCode,
			get compatibilityFlags(): string[] {
				throw failure;
			},
		};
		try {
			wrapped.load(bad);
			throw Error("expected");
		} catch (e) {
			expect(e).toBe(failure);
		}
		expect(load).not.toHaveBeenCalled();
		expect(spy).not.toHaveBeenCalled();
		try {
			wrapped.load(baseCode);
			throw Error("expected");
		} catch (e) {
			expect(e).toBe(failure);
		}
		expect(load).toHaveBeenCalledTimes(1);
		expect(events(spy).map((e) => e.phase)).toEqual(["attempted", "threw"]);
		expect(JSON.stringify(spy.mock.calls)).not.toContain(failure.message);
	});
	test.each([null, "private-worker-name"])(
		"cached get keeps callback lazy and original name %s",
		(name) => {
			const spy = vi.spyOn(console, "log").mockImplementation(() => {});
			const stub = {} as WorkerStub;
			const get = vi.fn(() => stub);
			const callback = vi.fn(() => baseCode);
			expect(
				withModelAuthoredCodeIsolation(
					{ load: vi.fn(), get } as WorkerLoader,
					host,
				).get(name, callback),
			).toBe(stub);
			expect(get.mock.calls[0]?.[0]).toBe(name);
			expect(callback).not.toHaveBeenCalled();
			expect(events(spy).map((e) => [e.identity, e.phase])).toEqual([
				[name === null ? "anonymous" : "named", "attempted"],
				[name === null ? "anonymous" : "named", "returned"],
			]);
			expect(JSON.stringify(spy.mock.calls)).not.toContain(
				"private-worker-name",
			);
		},
	);
	test.each(["callback", "hardening"])(
		"later named get %s failure does not rewrite native returned",
		async (kind) => {
			const spy = vi.spyOn(console, "log").mockImplementation(() => {});
			let later!: () => Promise<WorkerLoaderWorkerCode>;
			const failure = new Error("private later error");
			const stub = {} as WorkerStub;
			const get: WorkerLoader["get"] = (_name, callback) => {
				later = callback as typeof later;
				return stub;
			};
			const callback =
				kind === "callback"
					? () => {
							throw failure;
						}
					: () => ({
							...baseCode,
							get compatibilityFlags(): string[] {
								throw failure;
							},
						});
			expect(
				withModelAuthoredCodeIsolation(
					{ load: vi.fn(), get } as WorkerLoader,
					host,
				).get("private", callback),
			).toBe(stub);
			await expect(later()).rejects.toBe(failure);
			expect(events(spy).map((e) => e.phase)).toEqual([
				"attempted",
				"returned",
			]);
		},
	);
	test("native get synchronous error has exact attempted/threw outcome", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const failure = new Error("private");
		const callback = vi.fn(() => baseCode);
		const get = vi.fn(() => {
			throw failure;
		});
		try {
			withModelAuthoredCodeIsolation(
				{ load: vi.fn(), get } as WorkerLoader,
				host,
			).get(null, callback);
			throw new Error("Expected native get to throw");
		} catch (e) {
			expect(e).toBe(failure);
		}
		expect(callback).not.toHaveBeenCalled();
		expect(events(spy).map((e) => e.phase)).toEqual(["attempted", "threw"]);
	});
	test.each(["attempted", "returned", "threw"])(
		"throwing %s log sink cannot change native outcome",
		(phase) => {
			vi.spyOn(console, "log").mockImplementation((s) => {
				if (JSON.parse(String(s)).phase === phase) throw Error("sink");
			});
			const stub = {} as WorkerStub;
			const failure = new Error("native");
			const load = vi.fn(() => {
				if (phase === "threw") throw failure;
				return stub;
			});
			const w = withModelAuthoredCodeIsolation(
				{ load, get: vi.fn() } as WorkerLoader,
				host,
			);
			if (phase === "threw") {
				try {
					w.load(baseCode);
					throw new Error("Expected native load to throw");
				} catch (e) {
					expect(e).toBe(failure);
				}
			} else expect(w.load(baseCode)).toBe(stub);
			expect(load).toHaveBeenCalledTimes(1);
		},
	);
	test("invalid extra/mismatched/getter labels omit events; mutable labels are captured", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const stub = {} as WorkerStub;
		const load = vi.fn((_code: WorkerLoaderWorkerCode) => stub);
		for (const label of [
			Object.defineProperty({ ...host }, "private", { value: "secret" }),
			{ ...host, [Symbol("extra")]: "secret" },
			{ ...host, tenant: "private" },
			{ ...host, reason: "stored_tool_authored_invocation" },
			{
				get surface() {
					throw Error("labels");
				},
				reason: host.reason,
			},
		])
			expect(
				withModelAuthoredCodeIsolation(
					{ load, get: vi.fn() } as WorkerLoader,
					label as never,
				).load(baseCode),
			).toBe(stub);
		expect(spy).not.toHaveBeenCalled();
		const label = { ...host };
		const w = withModelAuthoredCodeIsolation(
			{ load, get: vi.fn() } as WorkerLoader,
			label,
		);
		Object.assign(label, { surface: "private", reason: "private" });
		w.load(baseCode);
		expect(events(spy)[0]).toMatchObject(host);
		expect(JSON.stringify(spy.mock.calls)).not.toContain("private");
	});
	test("actual installed SDK collision rejects before load; post-load entrypoint failure counts one attempted", async () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const failure = new Error("evaluate failure");
		const load = vi.fn(
			() =>
				({
					getEntrypoint: () => {
						throw failure;
					},
				}) as unknown as WorkerStub,
		);
		const executor = new DynamicWorkerExecutor({
			loader: withModelAuthoredCodeIsolation(
				{ load, get: vi.fn() } as WorkerLoader,
				host,
			),
			globalOutbound: null,
			timeout: 1000,
		});
		const collision = await executor.execute("async () => 1", [
			{
				name: "fixture",
				fns: { "same-name": async () => 1, same_name: async () => 2 },
			},
		]);
		expect(collision.error).toContain("both sanitize");
		expect(load).not.toHaveBeenCalled();
		expect(spy).not.toHaveBeenCalled();
		await expect(executor.execute("async () => 1", [])).rejects.toBe(failure);
		expect(load).toHaveBeenCalledTimes(1);
		expect(events(spy).map((e) => e.phase)).toEqual(["attempted", "returned"]);
	});
});

const diagnosticPairs = [
	{ surface: "tedi_browser_code", reason: "tedi_browser_authored_invocation" },
	{
		surface: "tedi_workspace_shell",
		reason: "tedi_workspace_shell_invocation",
	},
	{ surface: "cms_tenant_runtime", reason: "cms_tenant_bundle_lookup" },
	{ surface: "cms_tenant_plugin", reason: "cms_tenant_plugin_invocation" },
] as const;

describe("diagnostic-only native loader boundary", () => {
	test.each([...hostPairs, ...diagnosticPairs])(
		"exact raw native load/get and receiver, no construction events: $surface",
		(pair) => {
			const spy = vi.spyOn(console, "log").mockImplementation(() => {});
			const stub = {} as WorkerStub;
			let loaded: WorkerLoaderWorkerCode | undefined;
			let callback: unknown;
			const native: WorkerLoader = {
				load(code) {
					expect(this).toBe(native);
					loaded = code;
					return stub;
				},
				get(name, getCode) {
					expect(this).toBe(native);
					expect(name).toBe("private-name");
					callback = getCode;
					return stub;
				},
			};
			const wrapper = withDynamicWorkerLoaderDiagnostics(native, pair);
			expect(spy).not.toHaveBeenCalled();
			const getCode = vi.fn(() => baseCode);
			expect(wrapper.load(baseCode)).toBe(stub);
			expect(loaded).toBe(baseCode);
			expect(wrapper.get("private-name", getCode)).toBe(stub);
			expect(callback).toBe(getCode);
			expect(getCode).not.toHaveBeenCalled();
			expect(baseCode.compatibilityFlags).not.toContain(
				MODEL_AUTHORED_CODE_FLAG,
			);
			expect(events(spy)).toEqual(
				["load", "get"].flatMap((method) =>
					["attempted", "returned"].map((phase) => ({
						event: "tedix.dynamic_worker.loader_call",
						version: 1,
						...pair,
						method,
						identity: method === "get" ? "named" : "anonymous",
						phase,
					})),
				),
			);
			for (const event of events(spy))
				expect(Object.keys(event)).toEqual([
					"event",
					"version",
					"surface",
					"reason",
					"method",
					"identity",
					"phase",
				]);
			expect(JSON.stringify(spy.mock.calls)).not.toContain("private-name");
		},
	);
	test.each(diagnosticPairs)(
		"new pair does not widen original isolation validator: $surface",
		(pair) => {
			const spy = vi.spyOn(console, "log").mockImplementation(() => {});
			let hardened: WorkerLoaderWorkerCode | undefined;
			withModelAuthoredCodeIsolation(
				{
					load: (code) => {
						hardened = code;
						return {} as WorkerStub;
					},
					get: vi.fn(),
				} as WorkerLoader,
				pair as never,
			).load(baseCode);
			expect(spy).not.toHaveBeenCalled();
			expect(hardened?.compatibilityFlags).toContain(MODEL_AUTHORED_CODE_FLAG);
		},
	);
	test.each(diagnosticPairs)(
		"raw manifests are never inspected or cloned: $surface",
		(pair) => {
			const spy = vi.spyOn(console, "log").mockImplementation(() => {});
			const code = {
				...baseCode,
				get compatibilityFlags(): string[] {
					throw Error("must not inspect raw flags");
				},
			};
			const load = vi.fn(() => ({}) as WorkerStub);
			withDynamicWorkerLoaderDiagnostics(
				{ load, get: vi.fn() } as WorkerLoader,
				pair,
			).load(code);
			expect(load.mock.calls[0]?.[0]).toBe(code);
			expect(events(spy).map((e) => e.phase)).toEqual([
				"attempted",
				"returned",
			]);
		},
	);
	test.each([null, "private-cache-key"])(
		"get keeps original callback and null/name semantics: %s",
		(name) => {
			const spy = vi.spyOn(console, "log").mockImplementation(() => {});
			const failure = new Error("private later callback");
			const callback = vi.fn(() => {
				throw failure;
			});
			let captured!: typeof callback;
			const stub = {} as WorkerStub;
			const get: WorkerLoader["get"] = (key, cb) => {
				expect(key).toBe(name);
				captured = cb as typeof callback;
				return stub;
			};
			const wrapped = withDynamicWorkerLoaderDiagnostics(
				{ load: vi.fn(), get } as WorkerLoader,
				diagnosticPairs[0],
			);
			expect(wrapped.get(name, callback)).toBe(stub);
			expect(wrapped.get(name, callback)).toBe(stub);
			expect(callback).not.toHaveBeenCalled();
			expect(captured).toBe(callback);
			try {
				captured();
				throw Error("expected callback failure");
			} catch (e) {
				expect(e).toBe(failure);
			}
			expect(events(spy).map((e) => [e.identity, e.phase])).toEqual(
				["attempted", "returned", "attempted", "returned"].map((p) => [
					name === null ? "anonymous" : "named",
					p,
				]),
			);
		},
	);
	test.each(["load", "get"] as const)(
		"native %s synchronous error and sink errors preserve identity",
		(method) => {
			const failure = new Error("private native");
			const spy = vi.spyOn(console, "log").mockImplementation(() => {});
			const native = {
				load: () => {
					throw failure;
				},
				get: () => {
					throw failure;
				},
			} as WorkerLoader;
			const wrapper = withDynamicWorkerLoaderDiagnostics(
				native,
				diagnosticPairs[1],
			);
			try {
				if (method === "load") wrapper.load(baseCode);
				else wrapper.get(null, () => baseCode);
				throw Error("expected");
			} catch (e) {
				expect(e).toBe(failure);
			}
			expect(events(spy).map((e) => e.phase)).toEqual(["attempted", "threw"]);
			spy.mockImplementation(() => {
				throw Error("sink");
			});
			try {
				if (method === "load") wrapper.load(baseCode);
				else wrapper.get(null, () => baseCode);
				throw Error("expected");
			} catch (e) {
				expect(e).toBe(failure);
			}
			const stub = {} as WorkerStub;
			const success = withDynamicWorkerLoaderDiagnostics(
				{ load: () => stub, get: () => stub } as WorkerLoader,
				diagnosticPairs[1],
			);
			expect(success.load(baseCode)).toBe(stub);
			expect(success.get(null, () => baseCode)).toBe(stub);
		},
	);
	test("malformed labels omit events, snapshot getters once and caller mutation cannot rebind", () => {
		const spy = vi.spyOn(console, "log").mockImplementation(() => {});
		const stub = {} as WorkerStub;
		const native = { load: () => stub, get: () => stub } as WorkerLoader;
		for (const pair of diagnosticPairs)
			for (const label of [
				Object.defineProperty({ ...pair }, "private", { value: "secret" }),
				{ ...pair, [Symbol("extra")]: "secret" },
				{ ...pair, reason: "wrong" },
				{
					get surface() {
						throw Error("labels");
					},
					reason: pair.reason,
				},
			])
				expect(
					withDynamicWorkerLoaderDiagnostics(native, label as never).load(
						baseCode,
					),
				).toBe(stub);
		expect(spy).not.toHaveBeenCalled();
		let reads = 0;
		const pair = {
			get surface() {
				reads++;
				return "tedi_browser_code" as const;
			},
			reason: "tedi_browser_authored_invocation" as const,
		};
		const wrapped = withDynamicWorkerLoaderDiagnostics(native, pair);
		expect(reads).toBe(1);
		Object.assign(pair, { reason: "private" });
		wrapped.load(baseCode);
		expect(events(spy)[0]).toMatchObject(diagnosticPairs[0]);
		expect(JSON.stringify(spy.mock.calls)).not.toContain("secret");
	});
});

test("get-only SDK loader remains get-only and later async callback failure is not native throw", async () => {
	const error = new Error("fictional later callback failure");
	const callback = async () => {
		throw error;
	};
	const stub = {};
	let captured: typeof callback | undefined;
	const native = {
		get(_name: string, getCode: () => unknown) {
			expect(this).toBe(native);
			captured = getCode as typeof callback;
			return stub;
		},
	};
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const wrapped = withDynamicWorkerLoaderDiagnostics(
		native,
		diagnosticPairs[1]!,
	);
	expect("load" in wrapped).toBe(false);
	expect(wrapped.get("private-name", callback)).toBe(stub);
	expect(captured).toBe(callback);
	await expect(captured!()).rejects.toBe(error);
	expect(
		log.mock.calls.map(([value]) => JSON.parse(String(value)).phase),
	).toEqual(["attempted", "returned"]);
});
