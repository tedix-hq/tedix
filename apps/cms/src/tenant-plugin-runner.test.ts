import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { PluginManifest, SerializedRequest } from "emdash";
import {
	finalizePluginInstall,
	finalizePluginUpdate,
} from "../node_modules/emdash/src/plugins/install-finalization";

const binding = vi.hoisted(() => ({
	current: {
		validateBundle: vi.fn(),
		invokeHook: vi.fn(),
		invokeRoute: vi.fn(),
	} as
		| {
				validateBundle: ReturnType<typeof vi.fn>;
				invokeHook: ReturnType<typeof vi.fn>;
				invokeRoute: ReturnType<typeof vi.fn>;
		  }
		| undefined,
}));

vi.mock("cloudflare:workers", () => ({
	env: {
		get PLUGIN_HOST() {
			return binding.current;
		},
	},
}));

import { createSandboxRunner as createTedixRunner } from "../templates/tedix/src/lib/tenant-plugin-runner";
import { createSandboxRunner as createMarketingRunner } from "../templates/marketing/src/lib/tenant-plugin-runner";

const manifest: PluginManifest = {
	id: "kv-canary",
	version: "1.0.0",
	capabilities: [],
	allowedHosts: [],
	storage: {},
	hooks: ["plugin:install"],
	routes: ["read"],
	admin: {},
};
const request: SerializedRequest = {
	url: "https://site.test/_emdash/api/plugins/kv-canary/read",
	method: "POST",
	headers: {},
	meta: { ip: null, userAgent: null, referer: null, geo: null },
};

beforeEach(() => {
	binding.current = {
		validateBundle: vi.fn().mockResolvedValue({ ok: true, value: null }),
		invokeHook: vi.fn().mockResolvedValue({ ok: true, value: null }),
		invokeRoute: vi
			.fn()
			.mockResolvedValue({ ok: true, value: { installed: true } }),
	};
});

for (const [name, createRunner] of [
	["tedix", createTedixRunner],
	["marketing", createMarketingRunner],
] as const) {
	describe(`${name} tenant plugin runner`, () => {
		test("validates before loading and calls the parent by identity only", async () => {
			const runner = createRunner({ db: {} as never });
			expect(runner.isAvailable()).toBe(true);
			const instance = await runner.load(manifest, "untrusted bundle bytes");
			expect(binding.current?.validateBundle).toHaveBeenCalledWith(
				manifest,
				"untrusted bundle bytes",
			);
			await instance.invokeHook("plugin:install", { kind: "install" });
			expect(binding.current?.invokeHook).toHaveBeenCalledWith(
				"kv-canary",
				"1.0.0",
				"plugin:install",
				{ kind: "install" },
			);
			await expect(instance.invokeRoute("read", {}, request)).resolves.toEqual({
				installed: true,
			});
			expect(binding.current?.invokeRoute).toHaveBeenCalledWith(
				"kv-canary",
				"1.0.0",
				"read",
				{},
				request,
			);
		});

		test("rejects unsupported bundles and closes disabled or stale handles", async () => {
			const runner = createRunner({ db: {} as never });
			binding.current?.validateBundle.mockResolvedValueOnce({
				ok: false,
				error: "Sandbox plugin declares unsupported host access",
			});
			await expect(runner.load(manifest, "bytes")).rejects.toThrow(
				/unsupported host access/,
			);
			const instance = await runner.load(manifest, "bytes");
			instance.setActive?.(false);
			await expect(instance.invokeHook("plugin:install", {})).rejects.toThrow(
				/inactive/,
			);
			instance.setActive?.(true);
			await runner.terminateAll();
			await expect(instance.invokeRoute("read", {}, request)).rejects.toThrow(
				/inactive/,
			);
		});

		test("surfaces parent failures and missing binding", async () => {
			const runner = createRunner({ db: {} as never });
			const instance = await runner.load(manifest, "bytes");
			binding.current?.invokeRoute.mockResolvedValueOnce({
				ok: false,
				error: "Plugin is not active for this tenant and version",
			});
			await expect(instance.invokeRoute("read", {}, request)).rejects.toThrow(
				/not active for this tenant/,
			);
			binding.current = undefined;
			expect(runner.isAvailable()).toBe(false);
			await expect(instance.invokeHook("plugin:install", {})).rejects.toThrow(
				/host is unavailable/,
			);
		});
	});
}

test("the native Emdash private route authenticates before invoking the tenant host", async () => {
	// Exercise the 1.0 route that authenticates private plugin calls before dispatch.
	const { POST } =
		await import("emdash/internal/routes/api/plugins/_pluginId_/_...path_");
	const instance = await createTedixRunner({ db: {} as never }).load(
		manifest,
		"bytes",
	);
	const runtime = {
		getPluginRouteMeta: () => ({
			public: false,
			permission: "plugins:manage",
			methods: ["POST"],
		}),
		handlePluginApiRoute: async () => ({
			success: true,
			data: await instance.invokeRoute("read", {}, request),
		}),
	};
	const call = (user?: { id: string; role: number }) =>
		POST({
			params: { pluginId: "kv-canary", path: "read" },
			request: new Request(request.url, {
				method: "POST",
				headers: { "X-EmDash-Request": "1" },
			}),
			locals: { emdash: runtime, user },
		} as never);
	const denied = await call();
	expect(denied.status).toBe(401);
	expect(binding.current?.invokeRoute).not.toHaveBeenCalled();
	const allowed = await call({ id: "owner", role: 50 });
	expect(allowed.status).toBe(200);
	expect(binding.current?.invokeRoute).toHaveBeenCalledOnce();
});

for (const operation of ["install", "update"] as const) {
	test(`a missing registry bundle rolls back ${operation} before lifecycle success`, async () => {
		let persistedVersion = operation === "install" ? undefined : "1.0.0";
		let syncCalls = 0;
		const lifecycle = vi.fn();
		const rollbackLifecycle = vi.fn();
		persistedVersion = "2.0.0";
		const options = {
			pluginId: "kv-canary",
			syncRuntime: async () => {
				syncCalls++;
				if (persistedVersion === "2.0.0") {
					throw new Error(
						"EmDash: registry plugin kv-canary@2.0.0 not found in R2",
					);
				}
			},
			runLifecycle: lifecycle,
			rollback: async () => {
				persistedVersion = operation === "install" ? undefined : "1.0.0";
				return { success: true as const, data: null };
			},
			runRollbackLifecycle: rollbackLifecycle,
		};
		await expect(
			operation === "install"
				? finalizePluginInstall(options)
				: finalizePluginUpdate(options),
		).rejects.toThrow(/registry plugin kv-canary@2\.0\.0 not found in R2/);
		expect(persistedVersion).toBe(
			operation === "install" ? undefined : "1.0.0",
		);
		expect(syncCalls).toBe(2);
		expect(lifecycle).not.toHaveBeenCalled();
		expect(rollbackLifecycle).toHaveBeenCalledTimes(
			operation === "update" ? 1 : 0,
		);
	});
}

for (const operation of ["install", "update"] as const) {
	for (const hookOutcome of ["failed", "missing"] as const) {
		test(`${operation} finalization rolls back when the required install hook is ${hookOutcome}`, async () => {
			const hookError = new Error("malformed canonical plugin code");
			const lifecycleResult =
				hookOutcome === "failed"
					? [
							{
								success: false,
								error: hookError,
								pluginId: "kv-canary",
								duration: 0,
							},
						]
					: [];
			let persistedVersion: string | undefined = "2.0.0";
			let syncCalls = 0;
			const options = {
				pluginId: "kv-canary",
				requireLifecycleHook: true,
				syncRuntime: async () => {
					syncCalls++;
				},
				runLifecycle: vi.fn().mockResolvedValue(lifecycleResult),
				rollback: async () => {
					persistedVersion = operation === "install" ? undefined : "1.0.0";
					return { success: true as const, data: null };
				},
				runRollbackLifecycle: vi.fn(),
			};
			await expect(
				operation === "install"
					? finalizePluginInstall(options)
					: finalizePluginUpdate(options),
			).rejects.toThrow(
				hookOutcome === "failed"
					? /malformed canonical plugin code/
					: /install hook did not complete/,
			);
			expect(persistedVersion).toBe(
				operation === "install" ? undefined : "1.0.0",
			);
			expect(syncCalls).toBe(2);
			expect(options.runLifecycle).toHaveBeenCalledOnce();
		});
	}
}

test("registry finalization accepts one successful install hook result", async () => {
	const rollback = vi.fn();
	await finalizePluginInstall({
		pluginId: "kv-canary",
		requireLifecycleHook: true,
		syncRuntime: async () => {},
		runLifecycle: async () => [
			{ success: true, pluginId: "kv-canary", duration: 1 },
		],
		rollback,
	});
	expect(rollback).not.toHaveBeenCalled();
});
