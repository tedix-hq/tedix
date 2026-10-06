import assert from "node:assert/strict";
import { RuntimeConfigCache } from "./runtime-config-cache";
import { configRefreshEdgeDecision } from "./agent-status";
import { AGENT_PROMPT_VERSION } from "./runtime-tool-guidance";

// Native platform boundaries are mocked only for this source-level config test.
// The production config cache and DO methods below remain the actual modules.
const bunTestModule = "bun:test";
const { mock } = await import(bunTestModule);
mock.module("cloudflare:workers", () => ({
	DurableObject: class {},
	WorkerEntrypoint: class {},
	RpcTarget: class {},
	WorkflowEntrypoint: class {},
	tracing: {},
	exports: {},
	env: {},
}));
mock.module("cloudflare:email", () => ({ EmailMessage: class {} }));
mock.module("cloudflare:workflows", () => ({
	NonRetryableError: class extends Error {},
}));
const { tediDo } = await import("../test/tedi-do");
const { edgeFetch, tediRequest } = await import("../test/tedi-edge");

for (const [path, method, headers, expected] of [
	["/api/admin/invalidate-config", "POST", {}, "forbidden"],
	[
		"/api/admin/invalidate-config",
		"POST",
		{ "X-Service-Binding": "true" },
		"forward",
	],
	[
		"/api/admin/invalidate-config",
		"GET",
		{ "X-Service-Binding": "true" },
		"method_not_allowed",
	],
	[
		"/__internal/config/refresh",
		"POST",
		{ "X-Service-Binding": "true" },
		"deny_internal_path",
	],
] as const)
	assert.equal(
		configRefreshEdgeDecision(
			new Request(`https://example.test${path}`, { method, headers }),
		),
		expected,
	);

let value = 3;
let calls = 0;
const cache = new RuntimeConfigCache(async () => {
	calls++;
	return { definition: { workItemConcurrency: value } } as never;
});
const db = {} as D1Database;
assert.equal(await cache.getMaxConcurrentWorkItems(db, "tedi"), 3);
value = 7;
assert.equal(await cache.getMaxConcurrentWorkItems(db, "tedi"), 3);
cache.modelPolicy = {
	chatModelRef: "old",
	cronModelRef: null,
	observerModelRef: null,
};
cache.invalidate();
assert.equal(cache.modelPolicy, undefined);
assert.equal(await cache.getMaxConcurrentWorkItems(db, "tedi"), 7);
assert.equal(calls, 2);
let release!: (value: never) => void;
let pending = true;
const racing = new RuntimeConfigCache(async () =>
	pending
		? new Promise((resolve) => {
				release = resolve;
			})
		: ({ definition: { workItemConcurrency: 6 } } as never),
);
const oldRead = racing.getMaxConcurrentWorkItems(db, "tedi");
racing.invalidate();
pending = false;
release({ definition: { workItemConcurrency: 1 } } as never);
assert.equal(await oldRead, 6);
assert.equal(await racing.getMaxConcurrentWorkItems(db, "tedi"), 6);

// A lowered limit must fence admission even when the old read is already in flight.
for (const stale of ["value", "missing", "failure"] as const) {
	let finish!: (value: never) => void;
	let fail!: (reason: Error) => void;
	let first = true;
	const lowered = new RuntimeConfigCache(async () => {
		if (first) {
			first = false;
			return new Promise((resolve, reject) => {
				finish = resolve;
				fail = reject;
			});
		}
		return { definition: { workItemConcurrency: 1 } } as never;
	});
	const admissionLimit = lowered.getMaxConcurrentWorkItems(db, "tedi");
	lowered.invalidate();
	if (stale === "failure") fail(new Error("old read failed"));
	else
		finish(
			(stale === "missing"
				? undefined
				: { definition: { workItemConcurrency: 8 } }) as never,
		);
	const limit = await admissionLimit;
	assert.equal(limit, 1);
	assert.equal(
		1 < limit,
		false,
		"one occupied slot must prevent new admission after lowering to one",
	);
}

// --- DO route: reload config without interrupting in-flight work ---
{
	const abort = new AbortController();
	const mcpRuntime = { bound: true };
	const cache = new RuntimeConfigCache(async () => null);
	cache.modelPolicy = {
		chatModelRef: "old",
		cronModelRef: null,
		observerModelRef: null,
	};
	const agent = tediDo({
		env: {},
		state: { tediId: "tedi-1", governanceLoadedAt: 123 },
		runtimeConfigCache: cache,
		activeTurnAborts: new Map([["run-1", abort]]),
		mcpRuntime,
		setState(next: unknown) {
			agent.state = next;
		},
	});
	const refresh = (method: string) =>
		agent.onRequest(
			new Request("https://do.internal/__internal/config/refresh", { method }),
		);
	assert.equal((await refresh("GET")).status, 405);
	const response = await refresh("POST");
	assert.deepEqual(await response.json(), { ok: true });
	assert.equal(cache.generation, 1);
	assert.equal(cache.modelPolicy, undefined);
	assert.equal(agent.state.governanceLoadedAt, 0);
	assert.equal(agent.state.tediId, "tedi-1");
	assert.equal(abort.signal.aborted, false, "an in-flight turn keeps running");
	assert.equal(agent.mcpRuntime, mcpRuntime, "the bound MCP runtime is kept");
}

// --- edge: the platform alias forwards to the DO route; nothing else does ---
{
	const forwarded = await edgeFetch(
		tediRequest("/api/admin/invalidate-config", {
			method: "POST",
			serviceBinding: true,
		}),
	);
	assert.equal(forwarded.response.status, 200);
	assert.equal(forwarded.forwarded.length, 1);
	assert.equal(
		new URL(forwarded.forwarded[0]!.url).pathname,
		"/__internal/config/refresh",
	);
	assert.equal(forwarded.forwarded[0]!.method, "POST");
	for (const request of [
		tediRequest("/api/admin/invalidate-config", { method: "POST" }),
		tediRequest("/__internal/config/refresh", {
			method: "POST",
			serviceBinding: true,
		}),
	]) {
		const denied = await edgeFetch(request);
		assert.ok(denied.response.status >= 400);
		assert.equal(denied.forwarded.length, 0);
	}
}
console.log(
	"config refresh: auth, cache reload, in-flight invalidation, and non-interrupting DO wiring passed",
);

// --- config reads that straddle an invalidation are discarded and re-read ---
{
	// Warm-path governance reload.
	const cache = new RuntimeConfigCache(async () => null);
	const loads: string[] = [];
	const agent = tediDo({
		env: {},
		runtimeConfigCache: cache,
		state: {
			identityLoaded: true,
			slug: "acme",
			tediId: "tedi-1",
			systemPromptVersion: AGENT_PROMPT_VERSION,
			identityDiagnostics: { missingFiles: [] },
			telegramChannel: null,
			toolPolicy: { allow: ["old"] },
			budgets: {},
			governanceLoadedAt: 0,
		},
		setState(next: unknown) {
			agent.state = next;
		},
		maybeReconcileCrons() {},
		async loadTediGovernance() {
			loads.push("load");
			if (loads.length === 1) {
				cache.invalidate();
				return { toolPolicy: { allow: ["stale"] }, budgets: {} };
			}
			return { toolPolicy: { allow: ["fresh"] }, budgets: {} };
		},
	});
	await agent.ensureIdentity();
	assert.equal(loads.length, 2);
	assert.deepEqual(agent.state.toolPolicy, { allow: ["fresh"] });
}

{
	// Cold-path identity resolution.
	const cache = new RuntimeConfigCache(async () => null);
	const loads: string[] = [];
	const agent = tediDo({
		env: { TEDI_STORAGE: { get: async () => null } },
		runtimeConfigCache: cache,
		state: {},
		setState(next: unknown) {
			agent.state = next;
		},
		maybeReconcileCrons() {},
		async loadTelegramChannel() {
			return null;
		},
		async loadTediGovernance() {
			loads.push("load");
			if (loads.length === 1) {
				cache.invalidate();
				return { toolPolicy: { allow: ["stale"] }, budgets: {} };
			}
			return { toolPolicy: { allow: ["fresh"] }, budgets: {} };
		},
	});
	await agent.ensureIdentity({ tediId: "tedi-1", slug: "acme" });
	assert.equal(loads.length, 2);
	assert.equal(agent.state.identityLoaded, true);
	assert.deepEqual(agent.state.toolPolicy, { allow: ["fresh"] });
}

for (const via of ["api", "storage", "storage-failure"] as const) {
	// Model policy: an API read or a stored fallback that straddles an
	// invalidation must not become the cached policy.
	const cache = new RuntimeConfigCache(async () => null);
	let reads = 0;
	const policy = (chatModelRef: string) => ({
		chatModelRef,
		cronModelRef: null,
		observerModelRef: null,
	});
	const agent = tediDo({
		runtimeConfigCache: cache,
		state: { tediId: "tedi-1" },
		env:
			via === "api"
				? {
						API_SERVICE: {
							async fetch() {
								reads += 1;
								if (reads === 1) cache.invalidate();
								return Response.json({
									json: policy(reads === 1 ? "stale" : "fresh"),
								});
							},
						},
					}
				: {},
		ctx: {
			storage: {
				async get() {
					reads += 1;
					if (reads === 1) {
						cache.invalidate();
						if (via === "storage-failure") throw new Error("storage down");
					}
					return policy(reads === 1 ? "stale" : "fresh");
				},
				async put() {},
			},
		},
	});
	await agent.ensureModelPolicy();
	assert.equal(reads, 2, `${via}: the straddling read is repeated`);
	assert.equal(cache.modelPolicy?.chatModelRef, "fresh");
}
console.log("config reads straddling an invalidation are re-read");
