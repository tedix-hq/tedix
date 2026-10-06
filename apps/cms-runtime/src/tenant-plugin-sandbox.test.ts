import { env, exports as workerExports } from "cloudflare:workers";
import { beforeAll, describe, expect, test, vi } from "vite-plus/test";
import { createDbQueryClient } from "@tedix/db/query-client";
import {
	closeCmsRestoreFence,
	getCmsRestoreFenceState,
	releaseCmsRestoreFence,
} from "@tedix/db/queries/cms-restore-fences";
import type { PluginManifest, SerializedRequest } from "emdash";
import { tenantPluginCanaryEnabled } from "./index";
import {
	invokeTenantPluginTransport,
	TenantPluginKvBridge,
	type PluginHostResult,
	type TenantPluginScope,
} from "./tenant-plugin-executor";

const KV_PLUGIN_MODULE = `import { WorkerEntrypoint } from "cloudflare:workers";
let invocations = 0;
let staleBridge;
export default class Plugin extends WorkerEntrypoint {
  async invoke(operation, ...args) {
    invocations++;
    try {
      if (operation === "capture") {
        staleBridge = this.env.BRIDGE;
        return { invocations };
      }
      if (operation === "stale") {
        return { invocations, value: await staleBridge.kvGet(args[0]) };
      }
      if (operation === "network") {
        return { invocations, value: (await fetch("https://example.com/")).status };
      }
      const method = {
        get: "kvGet", set: "kvSet", versioned: "kvGetVersioned",
        cas: "kvCompareAndSet", cdel: "kvCompareAndDelete",
        delete: "kvDelete", list: "kvList"
      }[operation];
      if (!method) throw new Error("Unknown probe operation");
      return { invocations, value: await this.env.BRIDGE[method](...args) };
    } catch (error) {
      return { invocations, error: error.message };
    }
  }
}`;

interface PluginProbeResult {
	invocations: number;
	value?: unknown;
	error?: string;
}

type PluginHostEnv = {
	LOADER: WorkerLoader;
	DB_DO: DurableObjectNamespace;
	PLATFORM_DB: D1Database;
};

const platformD1 = (env as unknown as PluginHostEnv).PLATFORM_DB;
const platformDb = createDbQueryClient(platformD1);

beforeAll(async () => {
	await platformD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_sites (id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, status TEXT NOT NULL, restore_epoch INTEGER NOT NULL DEFAULT 0)",
		)
		.run();
	await platformD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_restore_fences (site_id TEXT PRIMARY KEY, slug TEXT NOT NULL, generation TEXT NOT NULL, capture_id TEXT NOT NULL, restore_epoch INTEGER, closed_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP))",
		)
		.run();
	await platformD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_deprovision_operations (id TEXT PRIMARY KEY)",
		)
		.run();
	await platformD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_restore_permits (id TEXT PRIMARY KEY, site_id TEXT NOT NULL, slug TEXT NOT NULL, restore_epoch INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'legacy', entered_at TEXT NOT NULL DEFAULT (CURRENT_TIMESTAMP))",
		)
		.run();
	await platformD1
		.prepare(
			"CREATE TABLE IF NOT EXISTS cms_capture_cron_pauses (site_id TEXT PRIMARY KEY, slug TEXT NOT NULL, capture_id TEXT NOT NULL, expires_at_unix INTEGER NOT NULL, drained_at_unix INTEGER)",
		)
		.run();
});

async function registerSite(scope: TenantPluginScope): Promise<void> {
	await platformD1
		.prepare(
			"INSERT OR IGNORE INTO cms_sites (id, slug, status) VALUES (?, ?, 'active')",
		)
		.bind(scope.siteId, scope.tenantSlug)
		.run();
}

async function createPluginStorage(
	host: PluginHostEnv,
	slug: string,
): Promise<void> {
	const id = host.DB_DO.idFromName(slug);
	const db = host.DB_DO.get(id) as unknown as {
		query(sql: string): Promise<unknown>;
	};
	await db.query(
		"CREATE TABLE IF NOT EXISTS _plugin_storage (plugin_id TEXT NOT NULL, collection TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL, revision TEXT NOT NULL, updated_at TEXT, PRIMARY KEY (plugin_id, collection, id))",
	);
}

async function createActiveRegistryPlugin(
	host: PluginHostEnv,
	slug: string,
	pluginId: string,
	version = "1.0.0",
): Promise<void> {
	await createPluginStorage(host, slug);
	const db = host.DB_DO.get(host.DB_DO.idFromName(slug)) as unknown as {
		query(sql: string, params?: unknown[]): Promise<unknown>;
	};
	await db.query(
		"CREATE TABLE IF NOT EXISTS _plugin_state (plugin_id TEXT PRIMARY KEY, version TEXT NOT NULL, status TEXT NOT NULL, source TEXT NOT NULL)",
	);
	await db.query(
		"INSERT INTO _plugin_state (plugin_id, version, status, source) VALUES (?, ?, 'active', 'registry')",
		[pluginId, version],
	);
}

const SANDBOX_MANIFEST: PluginManifest = {
	id: "private-canary",
	version: "1.0.0",
	capabilities: [],
	allowedHosts: [],
	storage: {},
	hooks: ["plugin:install"],
	routes: [
		{ name: "read", public: false, permission: "plugins:manage" },
		{ name: "network", public: false, permission: "plugins:manage" },
	],
	admin: {},
};

const SANDBOX_CODE = `export default {
  hooks: {
    "plugin:install": async () => "installed"
  },
  routes: {
    read: async () => ({ value: "private route" }),
    network: async () => {
      try { await fetch("https://example.com/"); return "unexpected network"; }
      catch (error) { return error.message; }
    }
  }
}`;

const NATIVE_KV_CODE = `export default {
  hooks: {
    "plugin:install": async (event, ctx) => {
      await ctx.kv.set("installed", event.value);
      const versioned = await ctx.kv.getVersioned("installed");
      const changed = await ctx.kv.compareAndSet("installed", versioned.revision, event.value + " updated");
      const stale = await ctx.kv.compareAndSet("installed", versioned.revision, "stale");
      return { changed: changed.applied, stale: stale.applied };
    }
  },
  routes: {
    read: async (_route, ctx) => ({ value: await ctx.kv.get("installed") }),
    network: async (_route, ctx) => {
      try { await ctx.kv.set("settings:secret", "forbidden"); return "unexpected settings"; }
      catch (error) { return error.message; }
    }
  }
}`;

const ROUTE_REQUEST: SerializedRequest = {
	url: "https://site.test/_emdash/api/plugins/private-canary/read",
	method: "POST",
	headers: {},
	meta: { ip: null, userAgent: null, referer: null, geo: null },
};

const canonicalBundleObjects = new Map<string, string>();

function mockCanonicalBundle(
	slug: string,
	manifest: PluginManifest = SANDBOX_MANIFEST,
	code = SANDBOX_CODE,
): void {
	for (const [name, body] of [
		["manifest.json", JSON.stringify(manifest)],
		["backend.js", code],
	] as const) {
		canonicalBundleObjects.set(
			`https://api.cloudflare.com/client/v4/accounts/test-account/r2/buckets/test-bucket-${slug}/objects/${encodeURIComponent(`registry/${manifest.id}/${manifest.version}/${name}`)}`,
			body,
		);
	}
	vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
		const url = typeof input === "string" ? input : input.toString();
		const body = canonicalBundleObjects.get(url);
		return body === undefined
			? new Response("Not Found", { status: 404 })
			: new Response(body, {
					status: 200,
					headers: {
						"content-length": String(new TextEncoder().encode(body).byteLength),
					},
				});
	});
}

function pluginHost(slug: string, siteId: string) {
	const factories = workerExports as unknown as {
		TenantPluginHost(options: {
			props: {
				tenantSlug: string;
				siteId: string;
				restoreEpoch: number;
				bucketName: string;
				accountId: string;
				r2Token: string;
			};
		}): {
			validateBundle(
				manifest: PluginManifest,
				code: string,
			): Promise<PluginHostResult>;
			invokeHook(
				pluginId: string,
				pluginVersion: string,
				hook: string,
				event: unknown,
			): Promise<PluginHostResult>;
			invokeRoute(
				pluginId: string,
				pluginVersion: string,
				route: string,
				input: unknown,
				request: SerializedRequest,
			): Promise<PluginHostResult>;
		};
	};
	return factories.TenantPluginHost({
		props: {
			tenantSlug: slug,
			siteId,
			restoreEpoch: 0,
			bucketName: `test-bucket-${slug}`,
			accountId: "test-account",
			r2Token: "test-token",
		},
	});
}

async function invokeKv(
	host: PluginHostEnv,
	scope: TenantPluginScope,
	operation: string,
	...args: unknown[]
): Promise<PluginProbeResult> {
	await registerSite(scope);
	return invokeTenantPluginTransport(
		host,
		scope,
		KV_PLUGIN_MODULE,
		(entrypoint) => entrypoint.invoke(operation, ...args),
	);
}

function directBridge(
	scope: TenantPluginScope,
	query: (
		sql: string,
		params?: unknown[],
	) => Promise<{ rows: Record<string, unknown>[] }>,
): TenantPluginKvBridge {
	return Object.assign(Object.create(TenantPluginKvBridge.prototype), {
		ctx: { props: { ...scope, invocationId: crypto.randomUUID() } },
		env: {
			PLATFORM_DB: platformD1,
			DB_DO: { idFromName: (slug: string) => slug, get: () => ({ query }) },
		},
	}) as TenantPluginKvBridge;
}

describe("plugin KV restore permits", () => {
	test("a close drains the underlying DO write and denies every subsequent write method", async () => {
		const scope: TenantPluginScope = {
			tenantSlug: `plugin-fence-${crypto.randomUUID().slice(0, 12)}`,
			siteId: crypto.randomUUID(),
			restoreEpoch: 0,
			pluginId: "fence-proof",
			pluginVersion: "1.0.0",
			grants: ["kv:read", "kv:write"],
		};
		await registerSite(scope);
		let finish!: (value: { rows: Record<string, unknown>[] }) => void;
		const query = vi.fn(
			() =>
				new Promise<{ rows: Record<string, unknown>[] }>((resolve) => {
					finish = resolve;
				}),
		);
		const bridge = directBridge(scope, query);
		bridge.kvBegin(
			(bridge as unknown as { ctx: { props: { invocationId: string } } }).ctx
				.props.invocationId,
		);
		try {
			const pending = bridge.kvSet("key", "value");
			await vi.waitFor(async () => {
				expect(
					(
						await getCmsRestoreFenceState(platformDb, {
							siteId: scope.siteId,
							slug: scope.tenantSlug,
						})
					).inFlight,
				).toBe(1);
			});
			const fence = {
				siteId: scope.siteId,
				slug: scope.tenantSlug,
				generation: "g1",
				captureId: "c1",
			};
			expect(await closeCmsRestoreFence(platformDb, fence)).toBe(true);
			expect(await releaseCmsRestoreFence(platformDb, fence)).toBe(false);
			for (const operation of [
				() => bridge.kvSet("key", "denied"),
				() => bridge.kvCompareAndSet("key", null, "denied"),
				() => bridge.kvCompareAndDelete("key", "revision"),
				() => bridge.kvDelete("key"),
			]) {
				await expect(operation()).rejects.toThrow(
					"CMS restore fence unavailable",
				);
			}
			expect(query).toHaveBeenCalledTimes(1);
			finish({ rows: [] });
			await expect(pending).resolves.toBeUndefined();
			expect((await getCmsRestoreFenceState(platformDb, fence)).inFlight).toBe(
				0,
			);
			expect(await releaseCmsRestoreFence(platformDb, fence)).toBe(true);
			const other = {
				...scope,
				tenantSlug: `other-${scope.tenantSlug}`,
				siteId: crypto.randomUUID(),
				restoreEpoch: 0,
			};
			await registerSite(other);
			const otherBridge = directBridge(
				other,
				vi.fn().mockResolvedValue({ rows: [] }),
			);
			const otherInvocationId = (
				otherBridge as unknown as { ctx: { props: { invocationId: string } } }
			).ctx.props.invocationId;
			otherBridge.kvBegin(otherInvocationId);
			try {
				await expect(otherBridge.kvDelete("key")).resolves.toBe(false);
			} finally {
				otherBridge.kvEnd(otherInvocationId);
			}
		} finally {
			bridge.kvEnd(
				(bridge as unknown as { ctx: { props: { invocationId: string } } }).ctx
					.props.invocationId,
			);
		}
	});

	test("a failed DO query releases its permit", async () => {
		const scope: TenantPluginScope = {
			tenantSlug: `plugin-fail-${crypto.randomUUID().slice(0, 12)}`,
			siteId: crypto.randomUUID(),
			restoreEpoch: 0,
			pluginId: "failure-proof",
			pluginVersion: "1.0.0",
			grants: ["kv:write"],
		};
		await registerSite(scope);
		const bridge = directBridge(
			scope,
			vi.fn().mockRejectedValue(new Error("DO failed")),
		);
		const invocationId = (
			bridge as unknown as { ctx: { props: { invocationId: string } } }
		).ctx.props.invocationId;
		bridge.kvBegin(invocationId);
		try {
			await expect(bridge.kvDelete("key")).rejects.toThrow("DO failed");
			expect(
				(
					await getCmsRestoreFenceState(platformDb, {
						siteId: scope.siteId,
						slug: scope.tenantSlug,
					})
				).inFlight,
			).toBe(0);
		} finally {
			bridge.kvEnd(invocationId);
		}
	});
});

/**
 * Emdash's CloudflareSandboxRunner reads LOADER from cloudflare:workers inside
 * the CMS tenant isolate. Keep this platform probe on the real Workers test
 * pool: a mock WorkerLoader can accidentally make nested loading look viable.
 */
describe("tenant plugin Worker Loader transport", () => {
	const pluginId = "same-plugin:1.0.0";

	test("separate parent-hosted worker names isolate equal plugin IDs", async () => {
		const runId = crypto.randomUUID();
		const loader = (env as unknown as { LOADER: WorkerLoader }).LOADER;
		const workers = ["tenant-a", "tenant-b"].map((tenant) =>
			loader.get(`${pluginId}:${tenant}:${runId}`, () => ({
				compatibilityDate: "2026-05-14",
				mainModule: "plugin.mjs",
				modules: {
					"plugin.mjs": {
						js: `let requests = 0;
							export default { fetch(_request, env) {
							  return Response.json({ tenant: env.TENANT, requests: ++requests });
							} };`,
					},
				},
				env: { TENANT: tenant },
			})),
		);
		const fetch = async (index: number) =>
			(await (
				await workers[index]!.getEntrypoint().fetch(
					new Request("https://probe.test/"),
				)
			).json()) as { tenant: string; requests: number };

		expect(await fetch(0)).toEqual({ tenant: "tenant-a", requests: 1 });
		expect(await fetch(1)).toEqual({ tenant: "tenant-b", requests: 1 });
		expect(await fetch(0)).toEqual({ tenant: "tenant-a", requests: 2 });
		expect(await fetch(1)).toEqual({ tenant: "tenant-b", requests: 2 });
	});

	test("rejects forwarding WorkerLoader into a tenant isolate", async () => {
		const loader = (env as unknown as { LOADER: WorkerLoader }).LOADER;
		const worker = loader.get(
			`nested-loader-probe:${crypto.randomUUID()}`,
			() => ({
				compatibilityDate: "2026-05-14",
				mainModule: "tenant.mjs",
				modules: {
					"tenant.mjs": {
						js: `export default { fetch() { return new Response("nested Loader available"); } };`,
					},
				},
				env: { LOADER: loader },
			}),
		);

		await expect(
			worker.getEntrypoint().fetch(new Request("https://probe.test/")),
		).rejects.toThrow(/WorkerLoader.*does not support serialization/);
	});

	test("rejects transferring a tenant entrypoint into a plugin worker", async () => {
		const runId = crypto.randomUUID();
		const loader = (env as unknown as { LOADER: WorkerLoader }).LOADER;
		const invokeTenant = async (tenant: string) => {
			const worker = loader.get(
				`tenant-bridge-probe:${tenant}:${runId}`,
				() => ({
					compatibilityDate: "2026-05-14",
					mainModule: "tenant.mjs",
					modules: {
						"tenant.mjs": {
							js: `import { WorkerEntrypoint } from "cloudflare:workers";
							export class TenantBridge extends WorkerEntrypoint {
							  async read() { return this.env.TENANT; }
							}
							export default class Tenant extends WorkerEntrypoint {
							  async ping() { return this.env.TENANT; }
							}`,
						},
					},
					env: { TENANT: tenant },
				}),
			);
			const bridge = worker.getEntrypoint("TenantBridge") as unknown as {
				read(): Promise<string>;
			};
			expect(await bridge.read()).toBe(tenant);
			const plugin = loader.get(`${pluginId}:${tenant}:${runId}`, () => ({
				compatibilityDate: "2026-05-14",
				mainModule: "plugin.mjs",
				modules: {
					"plugin.mjs": {
						js: `import { WorkerEntrypoint } from "cloudflare:workers";
							export default class Plugin extends WorkerEntrypoint {
							  async invoke() { return this.env.BRIDGE.read(); }
							}`,
					},
				},
				env: { BRIDGE: bridge },
			}));
			return await (
				plugin.getEntrypoint() as unknown as { invoke(): Promise<string> }
			).invoke();
		};

		await expect(invokeTenant("tenant-a")).rejects.toThrow(
			/Entrypoints to dynamically-loaded workers cannot be transferred/,
		);
		await expect(invokeTenant("tenant-b")).rejects.toThrow(
			/Entrypoints to dynamically-loaded workers cannot be transferred/,
		);
	});

	test("parent bridge keeps plugin KV in the resolved tenant Durable Object", async () => {
		const host = env as unknown as PluginHostEnv;
		const runId = crypto.randomUUID().slice(0, 12);
		const tenantA = `plugin-a-${runId}`;
		const tenantB = `plugin-b-${runId}`;
		await Promise.all([
			createPluginStorage(host, tenantA),
			createPluginStorage(host, tenantB),
		]);
		const common = {
			pluginId: "proof-plugin",
			pluginVersion: "1.0.0",
			grants: ["kv:read", "kv:write"] as TenantPluginScope["grants"],
		};
		const scopeA: TenantPluginScope = {
			...common,
			tenantSlug: tenantA,
			siteId: crypto.randomUUID(),
			restoreEpoch: 0,
		};
		const scopeB: TenantPluginScope = {
			...common,
			tenantSlug: tenantB,
			siteId: crypto.randomUUID(),
			restoreEpoch: 0,
		};

		expect(
			(await invokeKv(host, scopeA, "set", "shared", "value-a")).invocations,
		).toBe(1);
		expect(
			(await invokeKv(host, scopeB, "set", "shared", "value-b")).invocations,
		).toBe(1);
		expect((await invokeKv(host, scopeA, "get", "shared")).value).toBe(
			"value-a",
		);
		expect((await invokeKv(host, scopeB, "get", "shared")).value).toBe(
			"value-b",
		);
		await invokeKv(host, scopeB, "set", "b-only", "private-b");
		expect((await invokeKv(host, scopeA, "get", "b-only")).value).toBeNull();
		// A later call starts a fresh isolate, so prior module state and bindings
		// cannot be reused by the plugin.
		expect((await invokeKv(host, scopeA, "get", "shared")).invocations).toBe(1);
	}, 15_000);

	test("parent bridge denies a capability not granted to the plugin", async () => {
		const host = env as unknown as PluginHostEnv;
		const tenantSlug = `plugin-read-${crypto.randomUUID().slice(0, 12)}`;
		await createPluginStorage(host, tenantSlug);
		const scope: TenantPluginScope = {
			tenantSlug,
			siteId: crypto.randomUUID(),
			restoreEpoch: 0,
			pluginId: "read-only-plugin",
			pluginVersion: "1.0.0",
			grants: ["kv:read"],
		};

		expect(
			(await invokeKv(host, scope, "set", "key", "blocked")).error,
		).toMatch(/Missing capability: kv:write/);
		expect((await invokeKv(host, scope, "get", "key")).value).toBeNull();
	});

	test("KV is isolated by both tenant and plugin, with exact-prefix listing", async () => {
		const host = env as unknown as PluginHostEnv;
		const suffix = crypto.randomUUID().slice(0, 12);
		const tenantA = `plugin-kv-a-${suffix}`;
		const tenantB = `plugin-kv-b-${suffix}`;
		await Promise.all([
			createPluginStorage(host, tenantA),
			createPluginStorage(host, tenantB),
		]);
		const base = {
			pluginVersion: "1.0.0",
			grants: ["kv:read", "kv:write"] as TenantPluginScope["grants"],
		};
		const a1 = {
			...base,
			tenantSlug: tenantA,
			siteId: crypto.randomUUID(),
			restoreEpoch: 0,
			pluginId: "one",
		};
		const a2 = {
			...base,
			tenantSlug: tenantA,
			siteId: a1.siteId,
			restoreEpoch: 0,
			pluginId: "two",
		};
		const b1 = {
			...base,
			tenantSlug: tenantB,
			siteId: crypto.randomUUID(),
			restoreEpoch: 0,
			pluginId: "one",
		};
		await invokeKv(host, a1, "set", "state:shared", "a-one");
		await invokeKv(host, a2, "set", "state:shared", "a-two");
		await invokeKv(host, b1, "set", "state:shared", "b-one");
		await invokeKv(host, a1, "set", "state:a%_literal", 7);
		expect((await invokeKv(host, a1, "get", "state:shared")).value).toBe(
			"a-one",
		);
		expect((await invokeKv(host, a2, "get", "state:shared")).value).toBe(
			"a-two",
		);
		expect((await invokeKv(host, b1, "get", "state:shared")).value).toBe(
			"b-one",
		);
		expect((await invokeKv(host, a1, "list", "state:a%_")).value).toEqual([
			{ key: "state:a%_literal", value: 7 },
		]);
		expect((await invokeKv(host, a2, "list")).value).toEqual([
			{ key: "state:shared", value: "a-two" },
		]);
	}, 15_000);

	test("conditional writes and deletes are atomic across plugin requests", async () => {
		const host = env as unknown as PluginHostEnv;
		const tenantSlug = `plugin-cas-${crypto.randomUUID().slice(0, 12)}`;
		await createPluginStorage(host, tenantSlug);
		const scope: TenantPluginScope = {
			tenantSlug,
			siteId: crypto.randomUUID(),
			restoreEpoch: 0,
			pluginId: "cas-proof",
			pluginVersion: "1.0.0",
			grants: ["kv:read", "kv:write"],
		};
		expect(
			(await invokeKv(host, scope, "versioned", "counter")).value,
		).toBeNull();
		const created = (await invokeKv(host, scope, "cas", "counter", null, 0))
			.value as {
			applied: boolean;
			revision: string;
		};
		expect(created).toMatchObject({
			applied: true,
			revision: expect.any(String),
		});
		expect(
			(await invokeKv(host, scope, "cas", "counter", null, 1)).value,
		).toEqual({ applied: false });
		const competing = await Promise.all([
			invokeKv(host, scope, "cas", "counter", created.revision, 1),
			invokeKv(host, scope, "cas", "counter", created.revision, 2),
		]);
		expect(
			competing.filter((x) => (x.value as { applied: boolean }).applied),
		).toHaveLength(1);
		const current = (await invokeKv(host, scope, "versioned", "counter"))
			.value as {
			value: number;
			revision: string;
		};
		expect([1, 2]).toContain(current.value);
		expect(current.revision).not.toBe(created.revision);
		expect(
			(await invokeKv(host, scope, "cdel", "counter", created.revision)).value,
		).toEqual({ applied: false });
		expect(
			(await invokeKv(host, scope, "cdel", "counter", current.revision)).value,
		).toEqual({ applied: true });
		expect((await invokeKv(host, scope, "delete", "counter")).value).toBe(
			false,
		);
		await invokeKv(host, scope, "set", "counter", 3);
		expect((await invokeKv(host, scope, "delete", "counter")).value).toBe(true);
		expect((await invokeKv(host, scope, "list")).value).toEqual([]);
	}, 15_000);

	test("settings keys, missing grants, and oversized values stay outside the KV bridge", async () => {
		const host = env as unknown as PluginHostEnv;
		const tenantSlug = `plugin-deny-${crypto.randomUUID().slice(0, 12)}`;
		await createPluginStorage(host, tenantSlug);
		const scope: TenantPluginScope = {
			tenantSlug,
			siteId: crypto.randomUUID(),
			restoreEpoch: 0,
			pluginId: "deny-proof",
			pluginVersion: "1.0.0",
			grants: ["kv:read", "kv:write"],
		};
		const settingsOps: Array<[string, ...unknown[]]> = [
			["get", "settings:secret"],
			["set", "settings:secret", "no"],
			["versioned", "settings:secret"],
			["cas", "settings:secret", null, "no"],
			["cdel", "settings:secret", "revision"],
			["delete", "settings:secret"],
			["list", "settings:"],
		];
		for (const [operation, ...args] of settingsOps) {
			expect((await invokeKv(host, scope, operation, ...args)).error).toMatch(
				/Invalid plugin KV/,
			);
		}
		const db = host.DB_DO.get(host.DB_DO.idFromName(tenantSlug)) as unknown as {
			query(sql: string, params: unknown[]): Promise<unknown>;
		};
		await db.query(
			"INSERT INTO _plugin_storage (plugin_id, collection, id, data, revision) VALUES (?, '__kv', ?, ?, ?)",
			[
				scope.pluginId,
				"settings:legacy-secret",
				'"hidden"',
				crypto.randomUUID(),
			],
		);
		expect((await invokeKv(host, scope, "list")).value).toEqual([]);
		expect((await invokeKv(host, scope, "list", "set")).value).toEqual([]);
		expect(
			(await invokeKv(host, scope, "set", "key", "x".repeat(65_536))).error,
		).toMatch(/Invalid plugin KV value/);
		expect(
			(await invokeKv(host, scope, "cas", "key", null, undefined)).error,
		).toMatch(/Invalid plugin KV value/);
		expect((await invokeKv(host, scope, "cas", "key", "", 1)).error).toMatch(
			/Invalid plugin KV revision/,
		);
		expect((await invokeKv(host, scope, "get", "x".repeat(257))).error).toMatch(
			/Invalid plugin KV key/,
		);
		const readOnly = {
			...scope,
			pluginId: "read-only",
			grants: ["kv:read"] as TenantPluginScope["grants"],
		};
		const writeOnly = {
			...scope,
			pluginId: "write-only",
			grants: ["kv:write"] as TenantPluginScope["grants"],
		};
		expect(
			(await invokeKv(host, readOnly, "cas", "key", null, 1)).error,
		).toMatch(/Missing capability: kv:write/);
		expect((await invokeKv(host, readOnly, "delete", "key")).error).toMatch(
			/Missing capability: kv:write/,
		);
		expect((await invokeKv(host, writeOnly, "versioned", "key")).error).toMatch(
			/Missing capability: kv:read/,
		);
		expect((await invokeKv(host, writeOnly, "list")).error).toMatch(
			/Missing capability: kv:read/,
		);
	}, 15_000);
});

describe.sequential("plugin request-context boundary", () => {
	const host = env as unknown as PluginHostEnv;
	const scope: TenantPluginScope = {
		tenantSlug: `plugin-context-${crypto.randomUUID().slice(0, 12)}`,
		siteId: crypto.randomUUID(),
		restoreEpoch: 0,
		pluginId: "context-proof",
		pluginVersion: "1.0.0",
		grants: ["kv:read", "kv:write"],
	};

	test("captures a bridge in one request", async () => {
		await createPluginStorage(host, scope.tenantSlug);
		await invokeKv(host, scope, "set", "key", "safe");
		await invokeKv(host, scope, "capture");
		const result = await invokeKv(host, scope, "get", "key");
		expect(result.value ?? JSON.stringify(result)).toBe("safe");
	});

	test("a later request gets a fresh bridge and no outbound network", async () => {
		const result = await invokeKv(host, scope, "get", "key");
		expect(result.value ?? JSON.stringify(result)).toBe("safe");
		const stale = await invokeKv(host, scope, "stale", "key");
		expect(stale.error ?? JSON.stringify(stale)).toMatch(
			/undefined|request|context|closed/i,
		);
		expect((await invokeKv(host, scope, "network")).error).toBeTruthy();
	});
});

describe("parent-hosted Emdash sandbox runner", () => {
	test("only the exact disposable site ID receives a plugin host", () => {
		const siteId = crypto.randomUUID();
		expect(tenantPluginCanaryEnabled(undefined, siteId)).toBe(false);
		expect(tenantPluginCanaryEnabled("", siteId)).toBe(false);
		expect(tenantPluginCanaryEnabled("*", siteId)).toBe(false);
		expect(tenantPluginCanaryEnabled(crypto.randomUUID(), siteId)).toBe(false);
		expect(tenantPluginCanaryEnabled(siteId, siteId)).toBe(true);
	});

	test("validates a private zero-capability bundle before any tenant state exists", async () => {
		const slug = `runner-preflight-${crypto.randomUUID().slice(0, 12)}`;
		const host = pluginHost(slug, crypto.randomUUID());
		expect(await host.validateBundle(SANDBOX_MANIFEST, SANDBOX_CODE)).toEqual({
			ok: true,
			value: null,
		});
		for (const admin of [
			{ pages: [], widgets: [] },
			{ pages: [] },
			{ widgets: [] },
		] satisfies PluginManifest["admin"][]) {
			expect(
				await host.validateBundle({ ...SANDBOX_MANIFEST, admin }, SANDBOX_CODE),
			).toEqual({ ok: true, value: null });
		}
		for (const manifest of [
			{ ...SANDBOX_MANIFEST, capabilities: ["network:request"] },
			{ ...SANDBOX_MANIFEST, allowedHosts: ["example.com"] },
			{ ...SANDBOX_MANIFEST, storage: { records: {} } },
			{ ...SANDBOX_MANIFEST, admin: { pages: [{ id: "extension" }] } },
			{ ...SANDBOX_MANIFEST, admin: { widgets: [{ id: "extension" }] } },
			{ ...SANDBOX_MANIFEST, admin: { pages: null } },
			{ ...SANDBOX_MANIFEST, admin: undefined },
			{ ...SANDBOX_MANIFEST, admin: null },
			{ ...SANDBOX_MANIFEST, admin: [] },
			{ ...SANDBOX_MANIFEST, admin: { settingsSchema: {} } },
			{ ...SANDBOX_MANIFEST, admin: { editorPanels: [] } },
			{ ...SANDBOX_MANIFEST, admin: { unknownExtension: true } },
			{ ...SANDBOX_MANIFEST, hooks: ["content:afterPublish"] },
			{ ...SANDBOX_MANIFEST, hooks: [] },
			{ ...SANDBOX_MANIFEST, routes: [{ name: "read", public: true }] },
			{ ...SANDBOX_MANIFEST, routes: [{ name: "read", response: "raw" }] },
		] as unknown as PluginManifest[]) {
			expect(await host.validateBundle(manifest, SANDBOX_CODE)).toMatchObject({
				ok: false,
				error: expect.stringMatching(
					/unsupported host access|Invalid sandbox plugin/,
				),
			});
		}
		// A route-only bundle cannot skip install-time compilation and later fail
		// on its first request after the registry has reported success.
		expect(
			await host.validateBundle(
				{ ...SANDBOX_MANIFEST, hooks: [], routes: ["read"] },
				"export default { routes: { read: ( } }",
			),
		).toMatchObject({
			ok: false,
			error: expect.stringMatching(/unsupported host access/),
		});
		expect(await host.validateBundle(SANDBOX_MANIFEST, "")).toMatchObject({
			ok: false,
			error: expect.stringMatching(/Invalid sandbox plugin bundle/),
		});
	}, 15_000);

	test("tenant isolate can call its parent-pinned host without receiving Worker Loader", async () => {
		const host = env as unknown as PluginHostEnv;
		const slug = `runner-tenant-${crypto.randomUUID().slice(0, 12)}`;
		await createActiveRegistryPlugin(host, slug, SANDBOX_MANIFEST.id);
		mockCanonicalBundle(slug, {
			...SANDBOX_MANIFEST,
			admin: { pages: [], widgets: [] },
		});
		const tenant = host.LOADER.get(`runner-tenant:${slug}`, () => ({
			compatibilityDate: "2026-05-14",
			mainModule: "tenant.mjs",
			modules: {
				"tenant.mjs": {
					js: `import { WorkerEntrypoint } from "cloudflare:workers";
export default class Tenant extends WorkerEntrypoint {
  async install(pluginId, version, suppliedCode) {
    return this.env.PLUGIN_HOST.invokeHook(pluginId, version, "plugin:install", { suppliedCode });
  }
  async read(pluginId, version, request) {
    return this.env.PLUGIN_HOST.invokeRoute(pluginId, version, "read", {}, request);
  }
}`,
				},
			},
			env: { PLUGIN_HOST: pluginHost(slug, crypto.randomUUID()) },
		}));
		const entrypoint = tenant.getEntrypoint() as unknown as {
			install(
				pluginId: string,
				version: string,
				suppliedCode: string,
			): Promise<PluginHostResult>;
			read(
				pluginId: string,
				version: string,
				request: SerializedRequest,
			): Promise<PluginHostResult>;
		};
		expect(
			await entrypoint.install(
				SANDBOX_MANIFEST.id,
				SANDBOX_MANIFEST.version,
				`export default {hooks:{"plugin:install":async (_event, ctx) => ctx.kv.set("installed", "forged")}}`,
			),
		).toMatchObject({
			ok: true,
		});
		expect(
			await entrypoint.read(
				SANDBOX_MANIFEST.id,
				SANDBOX_MANIFEST.version,
				ROUTE_REQUEST,
			),
		).toEqual({ ok: true, value: { value: "private route" } });
		const forgedManifest = {
			...SANDBOX_MANIFEST,
			capabilities: ["content:read"],
		};
		expect(
			await entrypoint.install(
				forgedManifest as unknown as string,
				SANDBOX_MANIFEST.version,
				SANDBOX_CODE,
			),
		).toMatchObject({
			ok: false,
			error: expect.stringMatching(/Invalid plugin tenant scope/),
		});
	}, 15_000);

	test("runs the zero-host-access canary through the official wrapper", async () => {
		const host = env as unknown as PluginHostEnv;
		const suffix = crypto.randomUUID().slice(0, 12);
		const tenantA = `runner-a-${suffix}`;
		const tenantB = `runner-b-${suffix}`;
		await Promise.all([
			createActiveRegistryPlugin(host, tenantA, SANDBOX_MANIFEST.id),
			createActiveRegistryPlugin(host, tenantB, SANDBOX_MANIFEST.id),
		]);
		mockCanonicalBundle(tenantA);
		mockCanonicalBundle(tenantB);
		const runnerA = pluginHost(tenantA, crypto.randomUUID());
		const runnerB = pluginHost(tenantB, crypto.randomUUID());
		await runnerA.invokeHook(
			SANDBOX_MANIFEST.id,
			SANDBOX_MANIFEST.version,
			"plugin:install",
			{},
		);
		expect(
			await runnerA.invokeRoute(
				SANDBOX_MANIFEST.id,
				SANDBOX_MANIFEST.version,
				"read",
				{},
				ROUTE_REQUEST,
			),
		).toEqual({ ok: true, value: { value: "private route" } });
		const network = await runnerA.invokeRoute(
			SANDBOX_MANIFEST.id,
			SANDBOX_MANIFEST.version,
			"network",
			{},
			{
				...ROUTE_REQUEST,
				url: "https://site.test/_emdash/api/plugins/private-canary/network",
			},
		);
		expect(network).toMatchObject({ ok: true });
		if (network.ok) expect(network.value).not.toBe("unexpected network");
		expect(
			await runnerB.invokeRoute(
				SANDBOX_MANIFEST.id,
				SANDBOX_MANIFEST.version,
				"read",
				{},
				ROUTE_REQUEST,
			),
		).toEqual({ ok: true, value: { value: "private route" } });
		expect(
			await runnerA.invokeHook(
				SANDBOX_MANIFEST.id,
				SANDBOX_MANIFEST.version,
				"plugin:activate",
				{},
			),
		).toMatchObject({
			ok: false,
			error: expect.stringMatching(/not declared/),
		});
	}, 20_000);

	test("native registry KV persists through the official wrapper and isolates tenants and plugins", async () => {
		const host = env as unknown as PluginHostEnv;
		const slug = `runner-kv-${crypto.randomUUID().slice(0, 12)}`;
		const otherSlug = `runner-kv-other-${crypto.randomUUID().slice(0, 12)}`;
		const otherManifest = { ...SANDBOX_MANIFEST, id: "other-plugin" };
		for (const [tenant, manifest] of [
			[slug, SANDBOX_MANIFEST],
			[slug, otherManifest],
			[otherSlug, SANDBOX_MANIFEST],
		] as const) {
			await createActiveRegistryPlugin(host, tenant, manifest.id);
			mockCanonicalBundle(tenant, manifest, NATIVE_KV_CODE);
		}
		const siteId = crypto.randomUUID();
		const otherSiteId = crypto.randomUUID();
		for (const [tenant, id] of [
			[slug, siteId],
			[otherSlug, otherSiteId],
		] as const) {
			await registerSite({
				tenantSlug: tenant,
				siteId: id,
				restoreEpoch: 0,
				pluginId: SANDBOX_MANIFEST.id,
				pluginVersion: SANDBOX_MANIFEST.version,
				grants: [],
			});
		}
		const runner = pluginHost(slug, siteId);
		const otherRunner = pluginHost(otherSlug, otherSiteId);
		const read = (target: typeof runner, id = SANDBOX_MANIFEST.id) =>
			target.invokeRoute(
				id,
				SANDBOX_MANIFEST.version,
				"read",
				{},
				ROUTE_REQUEST,
			);
		expect(await read(runner)).toEqual({ ok: true, value: { value: null } });
		expect(
			await runner.invokeHook(
				SANDBOX_MANIFEST.id,
				SANDBOX_MANIFEST.version,
				"plugin:install",
				{ value: "native" },
			),
		).toEqual({ ok: true, value: { changed: true, stale: false } });
		expect(await read(runner)).toEqual({
			ok: true,
			value: { value: "native updated" },
		});
		expect(await read(runner, otherManifest.id)).toEqual({
			ok: true,
			value: { value: null },
		});
		expect(await read(otherRunner)).toEqual({
			ok: true,
			value: { value: null },
		});
		expect(
			await runner.invokeRoute(
				SANDBOX_MANIFEST.id,
				SANDBOX_MANIFEST.version,
				"network",
				{},
				ROUTE_REQUEST,
			),
		).toMatchObject({ ok: true, value: "Invalid plugin KV key" });
		const db = host.DB_DO.get(host.DB_DO.idFromName(slug)) as unknown as {
			query(
				sql: string,
				params?: unknown[],
			): Promise<{ rows: Record<string, unknown>[] }>;
		};
		expect(
			(
				await db.query(
					"SELECT id, data FROM _plugin_storage WHERE plugin_id = ? AND collection = '__kv'",
					[SANDBOX_MANIFEST.id],
				)
			).rows,
		).toEqual([{ id: "installed", data: JSON.stringify("native updated") }]);
	}, 20_000);

	test("denies wrong version, inactive state, and unsupported host access before execution", async () => {
		const host = env as unknown as PluginHostEnv;
		const tenant = `runner-deny-${crypto.randomUUID().slice(0, 12)}`;
		await createActiveRegistryPlugin(host, tenant, SANDBOX_MANIFEST.id);
		mockCanonicalBundle(tenant);
		const runner = pluginHost(tenant, crypto.randomUUID());
		expect(
			await runner.invokeHook(
				SANDBOX_MANIFEST.id,
				"2.0.0",
				"plugin:install",
				{},
			),
		).toMatchObject({ ok: false, error: expect.stringMatching(/not active/) });
		const unsupportedTenant = `runner-unsupported-${crypto.randomUUID().slice(0, 12)}`;
		const unsupported: PluginManifest = {
			...SANDBOX_MANIFEST,
			capabilities: ["content:read"],
		};
		await createActiveRegistryPlugin(
			host,
			unsupportedTenant,
			SANDBOX_MANIFEST.id,
		);
		mockCanonicalBundle(unsupportedTenant, unsupported);
		expect(
			await pluginHost(unsupportedTenant, crypto.randomUUID()).invokeHook(
				SANDBOX_MANIFEST.id,
				SANDBOX_MANIFEST.version,
				"plugin:install",
				{},
			),
		).toMatchObject({
			ok: false,
			error: expect.stringMatching(/unsupported host access/),
		});
		const db = host.DB_DO.get(host.DB_DO.idFromName(tenant)) as unknown as {
			query(sql: string, params?: unknown[]): Promise<unknown>;
		};
		await db.query(
			"UPDATE _plugin_state SET status = 'inactive' WHERE plugin_id = ?",
			[SANDBOX_MANIFEST.id],
		);
		expect(
			await runner.invokeHook(
				SANDBOX_MANIFEST.id,
				SANDBOX_MANIFEST.version,
				"plugin:install",
				{},
			),
		).toMatchObject({ ok: false, error: expect.stringMatching(/not active/) });
	}, 15_000);

	test("fails closed when active state has no canonical registry bundle", async () => {
		const host = env as unknown as PluginHostEnv;
		const slug = `runner-missing-${crypto.randomUUID().slice(0, 12)}`;
		await createActiveRegistryPlugin(host, slug, SANDBOX_MANIFEST.id);
		const runner = pluginHost(slug, crypto.randomUUID());
		expect(
			await runner.invokeHook(
				SANDBOX_MANIFEST.id,
				SANDBOX_MANIFEST.version,
				"plugin:install",
				{},
			),
		).toMatchObject({ ok: false });
	}, 15_000);

	test("install hook rejects malformed canonical code before install can succeed", async () => {
		const host = env as unknown as PluginHostEnv;
		const slug = `runner-malformed-${crypto.randomUUID().slice(0, 12)}`;
		await createActiveRegistryPlugin(host, slug, SANDBOX_MANIFEST.id);
		mockCanonicalBundle(
			slug,
			SANDBOX_MANIFEST,
			"export default { hooks: { 'plugin:install': ( } }",
		);
		const result = await pluginHost(slug, crypto.randomUUID()).invokeHook(
			SANDBOX_MANIFEST.id,
			SANDBOX_MANIFEST.version,
			"plugin:install",
			{},
		);
		expect(result).toMatchObject({ ok: false });
	}, 15_000);
});

test("native plugin transport exposes only its named bridge and denies ambient access", async () => {
	const host = env as unknown as PluginHostEnv;
	const scope: TenantPluginScope = {
		tenantSlug: `isolation-${crypto.randomUUID().slice(0, 12)}`,
		siteId: crypto.randomUUID(),
		restoreEpoch: 0,
		pluginId: "isolation-proof",
		pluginVersion: "1.0.0",
		grants: ["kv:read", "kv:write"],
	};
	await createPluginStorage(host, scope.tenantSlug);
	await registerSite(scope);
	const module = `import { WorkerEntrypoint } from "cloudflare:workers";
 export default class extends WorkerEntrypoint {
 async invoke() {
 await this.env.BRIDGE.kvSet("proof", "named-rpc");
 const allowed = await this.env.BRIDGE.kvGet("proof");
 let networkDenied = false;
 try { await fetch("https://example.com/ambient-forbidden"); } catch { networkDenied = true; }
 let importedEnvDenied = false;
 try { const runtime = await import("cloudflare:workers"); const imported = runtime.env; importedEnvDenied = !imported || Object.keys(imported).length === 0; } catch { importedEnvDenied = true; }
 return { allowed, keys: Object.keys(this.env), networkDenied, importedEnvDenied, secret: this.env.PLATFORM_SERVICE_TOKEN ?? null };
 }
 }`;
	const result = await invokeTenantPluginTransport(
		host,
		scope,
		module,
		(entrypoint) => entrypoint.invoke(),
	);
	expect(result).toEqual({
		allowed: "named-rpc",
		keys: ["BRIDGE"],
		networkDenied: true,
		importedEnvDenied: true,
		secret: null,
	});
}, 15000);
