import { describe, expect, it } from "vite-plus/test";

import { tenantRuntimeCacheKey } from "./tenant-cache-key";

const bundle = {
	etag: "active-bundle-etag",
	mainModule: "index.js",
	modulesJson: ["index.js"],
	r2Prefix: "tenant/v7",
	version: 7,
};

const org = {
	brandingJson: null,
	defaultLocale: "en",
	descopeTenantId: "org_example",
	publicPathPrefix: null,
	publicSiteUrl: "https://example.com",
	r2BucketName: "example-media",
	siteTitle: "Example",
	socialJson: null,
};

const env = { ENVIRONMENT: "production" };

describe("tenant Loader cache key", () => {
	it("invalidates when human assertion capability is activated or removed", () => {
		const before = tenantRuntimeCacheKey("example", bundle, org, env);
		const enabled = tenantRuntimeCacheKey(
			"example",
			bundle,
			{ ...org, humanAssertionBundleEtag: bundle.etag },
			env,
		);
		const removed = tenantRuntimeCacheKey("example", bundle, org, env);

		expect(enabled).not.toBe(before);
		expect(removed).toBe(before);
	});

	it("binds capability to the exact marker value", () => {
		const current = tenantRuntimeCacheKey(
			"example",
			bundle,
			{ ...org, humanAssertionBundleEtag: bundle.etag },
			env,
		);
		const stale = tenantRuntimeCacheKey(
			"example",
			bundle,
			{ ...org, humanAssertionBundleEtag: "previous-bundle-etag" },
			env,
		);

		expect(current).not.toBe(stale);
	});
});
