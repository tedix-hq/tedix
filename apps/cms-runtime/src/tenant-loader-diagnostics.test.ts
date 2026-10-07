import { afterEach, describe, expect, test, vi } from "vite-plus/test";

import { getTenantEntrypoint } from "./index";
import { tenantRuntimeCacheKey } from "./tenant-cache-key";

afterEach(() => vi.restoreAllMocks());

const args = {
	accountId: "fictional-account",
	r2Token: "fictional-private-token",
	internalAuthToken: "fictional-private-auth",
	humanAuthKey: undefined,
	slug: "fictional-tenant",
	restoreEpoch: 7,
	spans: {},
	bundle: {
		version: 3,
		etag: "fictional-etag",
		r2Prefix: "fictional/v3",
		mainModule: "index.js",
		modulesJson: ["index.js"],
	},
	org: {
		siteId: "fictional-site",
		r2BucketName: "fictional-media",
		siteTitle: "Fictional",
		defaultLocale: "en",
		brandingJson: null,
		socialJson: null,
		descopeTenantId: "fictional-org",
		publicSiteUrl: "https://example.test",
		publicPathPrefix: null,
	},
} as Parameters<typeof getTenantEntrypoint>[2];

const fields = [
	"event",
	"version",
	"surface",
	"reason",
	"method",
	"identity",
	"phase",
];
function event(phase: string) {
	return {
		event: "tedix.dynamic_worker.loader_call",
		version: 1,
		surface: "cms_tenant_runtime",
		reason: "cms_tenant_bundle_lookup",
		method: "get",
		identity: "named",
		phase,
	};
}

describe("CMS tenant production Loader boundary", () => {
	test.each([false, true])(
		"preserves stable keys, lazy factories and native entrypoint (canary %s)",
		(canary) => {
			const log = vi.spyOn(console, "log").mockImplementation(() => {});
			const entrypoint = { fetch: vi.fn(), scheduled: vi.fn() };
			const names: string[] = [];
			const factories: (() => unknown)[] = [];
			const native = {
				get(name: string, factory: () => unknown) {
					expect(this).toBe(native);
					names.push(name);
					factories.push(factory);
					return { getEntrypoint: () => entrypoint };
				},
			};
			const env = {
				LOADER: native,
				ENVIRONMENT: "production",
				CMS_PLUGIN_CANARY_SITE_ID: canary
					? args.org.siteId
					: "different-fictional-site",
			} as unknown as Parameters<typeof getTenantEntrypoint>[0];
			const ctx = {} as ExecutionContext;
			for (let i = 0; i < 2; i++)
				expect(getTenantEntrypoint(env, ctx, args)).toBe(entrypoint);
			const key = `${tenantRuntimeCacheKey(args.slug, args.bundle, args.org, env)}@restore:7@plugin-host:${canary ? "canary" : "off"}`;
			expect(names).toEqual([key, key]);
			expect(factories).toHaveLength(2);
			expect(args.spans).toEqual({});
			expect(
				getTenantEntrypoint(env, ctx, args, "fictional-recovery-key"),
			).toBe(entrypoint);
			expect(names[2]).toBe(
				`fictional-recovery-key@plugin-host:${canary ? "canary" : "off"}`,
			);
			const events = log.mock.calls.map(([s]) => JSON.parse(String(s)));
			expect(events).toEqual(
				Array.from({ length: 3 }, () => [
					event("attempted"),
					event("returned"),
				]).flat(),
			);
			for (const e of events) expect(Object.keys(e)).toEqual(fields);
			expect(JSON.stringify(events)).not.toContain("fictional");
		},
	);

	test.each([false, true])(
		"preserves original synchronous get failure with throwing sink %s",
		(sinkThrows) => {
			const failure = new Error("fictional-native-failure");
			const log = vi.spyOn(console, "log").mockImplementation(() => {
				if (sinkThrows) throw new Error("fictional-sink-failure");
			});
			const native = {
				get() {
					expect(this).toBe(native);
					throw failure;
				},
			};
			const env = { LOADER: native } as unknown as Parameters<
				typeof getTenantEntrypoint
			>[0];
			let thrown: unknown;
			try {
				getTenantEntrypoint(env, {} as ExecutionContext, args);
			} catch (error) {
				thrown = error;
			}
			expect(thrown).toBe(failure);
			expect(log.mock.calls.map(([s]) => JSON.parse(String(s)))).toEqual([
				event("attempted"),
				event("threw"),
			]);
		},
	);
});
