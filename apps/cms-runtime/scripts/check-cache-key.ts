import assert from "node:assert/strict";

import {
	TENANT_RUNTIME_LOADER_POLICY_VERSION,
	tenantRuntimeBundleHash,
	tenantRuntimeCacheKey,
	tenantRuntimeEnvHash,
} from "../src/tenant-cache-key";

const org = {
	r2BucketName: "tedix-cms-media-tedix",
	siteTitle: "Tedix",
	brandingJson: '{"primary":"#7c3aed"}',
	socialJson: '{"linkedin":"https://example.com"}',
	descopeTenantId: "org_tedix",
	publicSiteUrl: "https://blog.tedix.dev",
	publicPathPrefix: null,
	defaultLocale: "en",
};

const env = {
	ENVIRONMENT: "production",
	PLATFORM_API_URL: undefined,
	CMS_INTERNAL_AUTH_TOKEN: "cms_internal_secret_a",
	EMDASH_ENCRYPTION_KEY: "emdash_key_a",
	DESCOPE_PROJECT_ID: "descope_project_a",
};

const bundle = {
	version: 42,
	r2Prefix: "tedix/v42/",
	mainModule: "entry.mjs",
	etag: "bundle_hash_a",
	modulesJson: ["entry.mjs", "chunks/content.mjs"],
};

const base = tenantRuntimeEnvHash(org, env);
const baseBundle = tenantRuntimeBundleHash(bundle);
const baseCacheKey = tenantRuntimeCacheKey("tedix", bundle, org, env);

assert.ok(
	baseCacheKey.includes(`loader:${TENANT_RUNTIME_LOADER_POLICY_VERSION}`),
	"the cache key must carry the parent-owned loader policy revision so deploys can evict stale injected capability shapes",
);

assert.equal(
	base,
	tenantRuntimeEnvHash({ ...org }, { ...env }),
	"unchanged tenant runtime inputs should produce a stable loader cache key",
);

assert.notEqual(
	base,
	tenantRuntimeEnvHash(org, {
		...env,
		CMS_INTERNAL_AUTH_TOKEN: "cms_internal_secret_b",
	}),
	"rotating CMS_INTERNAL_AUTH_TOKEN must evict the tenant Worker Loader isolate",
);

assert.notEqual(
	base,
	tenantRuntimeEnvHash(org, {
		...env,
		EMDASH_ENCRYPTION_KEY: "emdash_key_b,emdash_key_a",
	}),
	"rotating EMDASH_ENCRYPTION_KEY must evict the tenant Worker Loader isolate",
);

assert.notEqual(
	base,
	tenantRuntimeEnvHash(org, {
		...env,
		DESCOPE_PROJECT_ID: "descope_project_b",
	}),
	"rotating DESCOPE_PROJECT_ID must evict the tenant Worker Loader isolate",
);

assert.notEqual(
	base,
	tenantRuntimeEnvHash(org, {
		...env,
		PLATFORM_API_URL: "https://api.example.com",
	}),
	"changing PLATFORM_API_URL must evict the tenant Worker Loader isolate",
);

assert.notEqual(
	base,
	tenantRuntimeEnvHash(
		{ ...org, publicSiteUrl: "https://www.acme.example" },
		env,
	),
	"tenant metadata changes should still evict the tenant Worker Loader isolate",
);

assert.equal(
	baseCacheKey,
	tenantRuntimeCacheKey("tedix", { ...bundle }, { ...org }, { ...env }),
	"unchanged bundle, tenant, and env inputs should produce a stable loader cache key",
);

assert.notEqual(
	baseBundle,
	tenantRuntimeBundleHash({ ...bundle, etag: "bundle_hash_b" }),
	"changing the active tenant bundle etag must evict the tenant Worker Loader isolate",
);

assert.notEqual(
	baseBundle,
	tenantRuntimeBundleHash({ ...bundle, r2Prefix: "tedix/v43/" }),
	"changing the active tenant bundle R2 prefix must evict the tenant Worker Loader isolate",
);

assert.notEqual(
	baseBundle,
	tenantRuntimeBundleHash({ ...bundle, mainModule: "server/entry.mjs" }),
	"changing the active tenant bundle entrypoint must evict the tenant Worker Loader isolate",
);

assert.notEqual(
	baseBundle,
	tenantRuntimeBundleHash({
		...bundle,
		modulesJson: [...bundle.modulesJson, "chunks/do-sql.mjs"],
	}),
	"changing the active tenant bundle module manifest must evict the tenant Worker Loader isolate",
);

for (const secret of [env.CMS_INTERNAL_AUTH_TOKEN, env.DESCOPE_PROJECT_ID]) {
	assert.ok(
		!base.includes(secret),
		"tenant env hash must not contain raw secret material",
	);
	assert.ok(
		!baseCacheKey.includes(secret),
		"loader cache key must not contain raw secret material",
	);
}

console.log("cms-runtime cache key check passed");
