import { CatalogueSearchInputJsonSchema } from "@tedix/api-contract/schemas/tools";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildMcpServer } from "./server-factory";
import type { CachedAppData } from "./server-factory";
import { env } from "cloudflare:workers";
import { DynamicWorkerExecutor, ToolDispatcher } from "@cloudflare/codemode";
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

// Test-only: hold one real named entrypoint, unlike the SDK's ordinary disposal.
// This is a counterexample probe, never a production load→get adapter.
const probeProgram = `async () => {
  const r = await scope.request();
  const key = r.key;
  const nonce = globalThis[key]?.nonce ?? crypto.randomUUID();
  if (r.mode === "write") {
    Object.defineProperty(globalThis, key, { value: {
      nonce, data: r.marker, lexical: () => r.marker,
      rpc: () => scope.echo({ marker: r.marker })
    }, configurable: false });
    Object.defineProperty(Object.prototype, key + "_prototype", { value: r.marker, configurable: false });
  }
  if (r.mode === "overlap") {
    if (!globalThis[key]) globalThis[key] = { nonce };
    await scope.hold();
    console.log(r.marker); console.warn(r.marker); console.error(r.marker);
  }
  if (r.mode === "reject") await scope.fail();
  if (r.mode === "fetch") await fetch("https://example.com/fictional-forbidden");
  if (r.mode === "delayed") { await scope.hold(); await scope.echo({ marker: r.marker }); }
  let retainedRpc = null;
  if (r.mode === "read" && globalThis[key]?.rpc) {
    try { retainedRpc = { value: await globalThis[key].rpc() }; }
    catch (error) { retainedRpc = { error: String(error.message) }; }
  }
  const runtime = await import("cloudflare:workers");
  return { nonce: globalThis[key]?.nonce ?? nonce,
    data: globalThis[key]?.data ?? null,
    lexical: globalThis[key]?.lexical?.() ?? null,
    prototype: ({} )[key + "_prototype"] ?? null, retainedRpc,
    importedEnv: Object.keys(runtime.env ?? {}),
    ambientEnv: typeof env, ambientToken: typeof PLATFORM_SERVICE_TOKEN };
}`;

type ProbeResult = {
	result?: {
		nonce: string;
		data: string | null;
		lexical: string | null;
		prototype: string | null;
		retainedRpc: { value?: string; error?: string } | null;
		importedEnv: string[];
		ambientEnv: string;
		ambientToken: string;
	};
	logs?: string[];
	error?: string;
};
function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}
function disposeOwned(value: unknown) {
	const disposable = value as { [Symbol.dispose]?: () => void };
	disposable[Symbol.dispose]?.();
}
async function barrier(promise: Promise<void>) {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(
					() => reject(new Error("fictional RPC barrier timed out")),
					5000,
				);
			}),
		]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}
async function actualManifest() {
	const native = (env as unknown as { LOADER: WorkerLoader }).LOADER;
	let captured: WorkerLoaderWorkerCode | undefined;
	const loader = {
		load(code: WorkerLoaderWorkerCode) {
			captured = code;
			return native.load(code);
		},
		get: native.get.bind(native),
	} satisfies WorkerLoader;
	const baseline = await new DynamicWorkerExecutor({
		loader: withModelAuthoredCodeIsolation(loader),
		timeout: 5000,
		globalOutbound: null,
	}).execute(probeProgram, [
		{
			name: "scope",
			fns: {
				request: async () => ({ mode: "read", key: crypto.randomUUID() }),
			},
		},
	]);
	expect(baseline.error).toBeUndefined();
	expect(captured).toBeDefined();
	expect(captured!.globalOutbound).toBeNull();
	expect(captured!.env).toBeUndefined();
	expect(captured!.compatibilityFlags).toContain("disallow_importable_env");
	return { native, code: captured! };
}
function namedProbe(native: WorkerLoader, code: WorkerLoaderWorkerCode) {
	const name = `fictional-probe-${crypto.randomUUID()}`;
	const original = JSON.stringify(code);
	// Cached get() may never call getCode: compare BEFORE asking the Loader.
	const get = (candidate: WorkerLoaderWorkerCode) => {
		if (JSON.stringify(candidate) !== original)
			throw new Error("named manifest changed");
		return native.get(name, () => candidate);
	};
	const worker = get(code);
	const entrypoint = worker.getEntrypoint() as unknown as {
		evaluate(dispatchers: { scope: ToolDispatcher }): Promise<ProbeResult>;
		[Symbol.dispose]?: () => void;
	};
	return { get, worker, entrypoint };
}
function dispatcher(
	request: Record<string, unknown>,
	fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {},
) {
	return new ToolDispatcher({ request: async () => request, ...fns });
}

describe("named SDK manifest request-isolation counterexamples", () => {
	it("compares anonymous fresh realms with held named globals, prototypes, lexical and RPC closures", async ({
		task,
	}) => {
		const { native, code } = await actualManifest();
		const key = `__fictional_${crypto.randomUUID().replaceAll("-", "")}`;
		const calls: string[] = [];
		const providers = (mode: string, marker: string) => [
			{
				name: "scope",
				fns: {
					request: async () => ({ mode, marker, key }),
					echo: async () => {
						calls.push(marker);
						return marker;
					},
				},
			},
		];
		const fresh = executor();
		const anonymousA = await fresh.execute(
			probeProgram,
			providers("write", "alpha"),
		);
		const anonymousB = await fresh.execute(
			probeProgram,
			providers("read", "beta"),
		);
		expect(anonymousA.error).toBeUndefined();
		expect(anonymousB.error).toBeUndefined();
		expect(anonymousB.result).toMatchObject({
			data: null,
			prototype: null,
			lexical: null,
			retainedRpc: null,
		});
		const named = namedProbe(native, code);
		const a = dispatcher(
			{ mode: "write", marker: "alpha", key },
			{
				echo: async () => {
					calls.push("held-alpha");
					return "alpha";
				},
			},
		);
		const b = dispatcher(
			{ mode: "read", marker: "beta", key },
			{
				echo: async () => {
					calls.push("held-beta");
					return "beta";
				},
			},
		);
		try {
			const first = await named.entrypoint.evaluate({ scope: a });
			const second = await named.entrypoint.evaluate({ scope: b });
			expect(first.error).toBeUndefined();
			expect(second.error).toBeUndefined();
			const ambient = await named.entrypoint.evaluate({
				scope: dispatcher({ mode: "fetch", key }),
			});
			expect(ambient.error).toBeTruthy();
			expect(ambient.result).toBeUndefined();
			expect(() => named.get({ ...code, globalOutbound: undefined })).toThrow(
				"named manifest changed",
			);
			const warm = first.result!.nonce === second.result!.nonce;
			if (warm) {
				expect(second.result).toMatchObject({
					data: "alpha",
					prototype: "alpha",
					lexical: "alpha",
				});
				if (second.result!.retainedRpc?.value) {
					expect(second.result!.retainedRpc.value).toBe("alpha");
					expect(calls).toContain("held-alpha");
					expect(calls).not.toContain("held-beta");
				} else expect(second.result!.retainedRpc?.error).toBeTruthy();
			} else expect(second.result!.data).toBeNull();
			expect(second.result).toMatchObject({
				importedEnv: [],
				ambientEnv: "undefined",
				ambientToken: "undefined",
			});
			Object.assign(task.meta, {
				namedReuse: {
					probe: "held-named-realm",
					classification: warm ? "RISK_DEMONSTRATED" : "UNPROVEN",
					retainedRpc: second.result!.retainedRpc,
					calls,
				},
			});
		} finally {
			disposeOwned(named.entrypoint);
			disposeOwned(named.worker);
		}
	});

	it("uses real RPC barriers to detect cross-request console collectors on overlapping evaluations", async ({
		task,
	}) => {
		const { native, code } = await actualManifest();
		const named = namedProbe(native, code);
		const key = `__overlap_${crypto.randomUUID().replaceAll("-", "")}`;
		const enteredA = deferred(),
			enteredB = deferred(),
			releaseA = deferred(),
			releaseB = deferred();
		const a = dispatcher(
			{ mode: "overlap", key, marker: "alpha-log" },
			{
				hold: async () => {
					enteredA.resolve();
					await releaseA.promise;
				},
			},
		);
		const b = dispatcher(
			{ mode: "overlap", key, marker: "beta-log" },
			{
				hold: async () => {
					enteredB.resolve();
					await releaseB.promise;
				},
			},
		);
		const pending: Promise<ProbeResult>[] = [];
		try {
			const pa = named.entrypoint.evaluate({ scope: a });
			pending.push(pa);
			void pa.catch(() => {});
			await barrier(enteredA.promise);
			const pb = named.entrypoint.evaluate({ scope: b });
			pending.push(pb);
			void pb.catch(() => {});
			await barrier(enteredB.promise);
			releaseA.resolve();
			const first = await pa;
			releaseB.resolve();
			const second = await pb;
			expect(first.error).toBeUndefined();
			expect(second.error).toBeUndefined();
			const warm = first.result!.nonce === second.result!.nonce;
			if (warm) {
				expect(first.logs).toEqual([]);
				expect(second.logs).toEqual([
					"alpha-log",
					"[warn] alpha-log",
					"[error] alpha-log",
					"beta-log",
					"[warn] beta-log",
					"[error] beta-log",
				]);
			} else {
				expect(first.logs).toEqual([
					"alpha-log",
					"[warn] alpha-log",
					"[error] alpha-log",
				]);
			}
			Object.assign(task.meta, {
				namedReuse: {
					probe: "overlapping-console",
					classification: warm ? "RISK_DEMONSTRATED" : "UNPROVEN",
					firstLogs: first.logs,
					secondLogs: second.logs,
				},
			});
		} finally {
			releaseA.resolve();
			releaseB.resolve();
			await Promise.allSettled(pending);
			disposeOwned(named.entrypoint);
			disposeOwned(named.worker);
		}
	});

	it("observes rejected RPC and timeout continuation without treating timeout as realm reset", async ({
		task,
	}) => {
		const { native, code } = await actualManifest();
		const named = namedProbe(native, code);
		const release = deferred(),
			entered = deferred();
		const key = crypto.randomUUID();
		let effects = 0;
		const pending: Promise<ProbeResult>[] = [];
		try {
			const denied = await named.entrypoint.evaluate({
				scope: dispatcher(
					{ mode: "reject", key },
					{
						fail: async () => {
							throw new Error("fictional RPC denied");
						},
					},
				),
			});
			expect(denied.error).toContain("fictional RPC denied");
			const p = named.entrypoint.evaluate({
				scope: dispatcher(
					{ mode: "delayed", key, marker: "late" },
					{
						hold: async () => {
							entered.resolve();
							await release.promise;
						},
						echo: async () => {
							effects++;
							return "late";
						},
					},
				),
			});
			pending.push(p);
			void p.catch(() => {});
			await barrier(entered.promise);
			const timed = await p;
			expect(timed.error).toBe("Execution timed out");
			expect(effects).toBe(0);
			release.resolve();
			// This later read bounds the observation window; it does not prove cancellation.
			const fence = await named.entrypoint.evaluate({
				scope: dispatcher({ mode: "read", key }),
			});
			expect(fence.error).toBeUndefined();
			Object.assign(task.meta, {
				namedReuse: {
					probe: "timeout-not-cancellation",
					classification: "UNPROVEN",
					effectsAfterOrderedRead: effects,
				},
			});
		} finally {
			release.resolve();
			await Promise.allSettled(pending);
			disposeOwned(named.entrypoint);
			disposeOwned(named.worker);
		}
	});

	it("separately observes the ordinary SDK disposal boundary with a test-only named adapter", async ({
		task,
	}) => {
		const { native, code } = await actualManifest();
		const name = `fictional-sdk-disposal-${crypto.randomUUID()}`;
		const original = JSON.stringify(code);
		const namedLoader = {
			load(candidate: WorkerLoaderWorkerCode) {
				if (JSON.stringify(candidate) !== original)
					throw new Error("named manifest changed");
				return native.get(name, () => candidate);
			},
			get: native.get.bind(native),
		} satisfies WorkerLoader;
		const sdk = new DynamicWorkerExecutor({
			loader: withModelAuthoredCodeIsolation(namedLoader),
			timeout: 5000,
			globalOutbound: null,
		});
		const key = `__disposal_${crypto.randomUUID().replaceAll("-", "")}`;
		const run = (mode: string) =>
			sdk.execute(probeProgram, [
				{
					name: "scope",
					fns: {
						request: async () => ({ mode, key, marker: "fictional" }),
						echo: async () => "fictional",
					},
				},
			]);
		const first = await run("write"),
			second = await run("read");
		expect(first.error).toBeUndefined();
		expect(second.error).toBeUndefined();
		const a = first.result as ProbeResult["result"],
			b = second.result as ProbeResult["result"];
		const warm = a!.nonce === b!.nonce;
		if (warm) expect(b!.data).toBe("fictional");
		else expect(b!.data).toBeNull();
		Object.assign(task.meta, {
			namedReuse: {
				probe: "ordinary-sdk-disposal",
				classification: warm ? "RISK_DEMONSTRATED" : "UNPROVEN",
				warm,
			},
		});
	});
});

it("native catalog uses zero real Loader calls while arbitrary code remains isolated", async () => {
	const native = (env as unknown as { LOADER: WorkerLoader }).LOADER;
	let loads = 0;
	let gets = 0;
	const loader = {
		load(...args: Parameters<WorkerLoader["load"]>) {
			loads++;
			return native.load(...args);
		},
		get(...args: Parameters<WorkerLoader["get"]>) {
			gets++;
			return native.get(...args);
		},
	} as WorkerLoader;
	const cached = {
		app: {
			id: "fictional-app",
			slug: "fictional",
			name: "Fictional",
			visibility: "public",
		},
		tools: [
			{
				id: "fictional-row",
				toolId: "find_tools",
				title: "Find tools",
				description: "Discovery",
				toolTypeId: "rpc",
				enabled: true,
				config: { transport: "catalog", endpoint: "catalog/search" },
				inputSchema: CatalogueSearchInputJsonSchema,
				outputSchema: null,
				annotations: { readOnlyHint: true },
			},
		],
		metadata: {
			mcpConfig: {
				codeMode: true,
				authMode: "authenticated",
				toolScopes: { find_tools: ["mcp:catalog.read"] },
			},
		},
		catalogMcp: null,
		catalogResources: [],
		catalogResourceTemplates: [],
		catalogPrompts: [],
		capabilities: {},
		expiresAt: Date.now() + 60000,
	} as unknown as CachedAppData;
	const server = await buildMcpServer(
		cached,
		{ authType: "service", scopes: ["mcp:catalog.read"] },
		{
			...env,
			LOADER: loader,
			API_URL: "https://api.fixture.test",
			API_SERVICE: {
				fetch: async () => Response.json({ json: { skills: [] } }),
			},
		} as unknown as CloudflareEnv,
		{
			waitUntil(p: Promise<unknown>) {
				void p.catch(() => {});
			},
		} as ExecutionContext,
		undefined,
		undefined,
		undefined,
		undefined,
		undefined,
		"find_tools",
	);
	const [client, transport] = InMemoryTransport.createLinkedPair();
	const pending = new Map<number, (message: Record<string, unknown>) => void>();
	let id = 0;
	client.onmessage = (message) => {
		const value = message as unknown as Record<string, unknown>;
		if (typeof value.id === "number") {
			pending.get(value.id)?.(value);
			pending.delete(value.id);
		}
	};
	await server.connect(transport);
	async function request(method: string, params: Record<string, unknown>) {
		const next = ++id;
		const response = new Promise<Record<string, unknown>>((resolve) =>
			pending.set(next, resolve),
		);
		await client.send({ jsonrpc: "2.0", id: next, method, params } as never);
		return response;
	}
	await request("initialize", {
		protocolVersion: "2025-11-25",
		capabilities: {},
		clientInfo: { name: "fictional-native", version: "1" },
	});
	await client.send({
		jsonrpc: "2.0",
		method: "notifications/initialized",
	} as never);
	const result = await request("tools/call", {
		name: "find_tools",
		arguments: { query: "" },
	});
	expect(result.error).toBeUndefined();
	expect((result.result as { isError?: boolean }).isError).not.toBe(true);
	expect(loads).toBe(0);
	expect(gets).toBe(0);
	await server.close();
	const executed = await new DynamicWorkerExecutor({
		loader: withModelAuthoredCodeIsolation(loader),
		timeout: 5000,
		globalOutbound: null,
	}).execute("async () => ({ ambient: typeof env, value: 42 })", []);
	expect(executed.error).toBeUndefined();
	expect(executed.result).toEqual({ ambient: "undefined", value: 42 });
	expect(loads).toBe(1);
	expect(gets).toBe(0);
});
