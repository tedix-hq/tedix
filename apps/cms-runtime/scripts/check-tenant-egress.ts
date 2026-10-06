import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { tenantEgressDecision } from "../src/tenant-egress-policy";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const runtimeSource = readFileSync(
	join(repoRoot, "apps/cms-runtime/src/index.ts"),
	"utf8",
);
const proxySource = readFileSync(
	join(repoRoot, "apps/cms-runtime/src/outbound-proxy.ts"),
	"utf8",
);

for (const url of [
	"https://api.cloudflare.com/client/v4/zones/example/purge_cache",
	"https://example.com/content",
	"https://cdn.example.com:8443/asset",
]) {
	assert.deepEqual(
		tenantEgressDecision(url),
		{
			decision: "allow",
			host: new URL(url).hostname,
			reason: null,
		},
		`public HTTPS tenant egress should remain available: ${url}`,
	);
}

for (const [url, reason] of [
	["http://example.com", "URL must use HTTPS"],
	["https://127.0.0.1/admin", "Cannot connect to private networks"],
	[
		"https://169.254.169.254/latest/meta-data",
		"Cannot connect to private networks",
	],
	["https://api.tedix.dev/internal", "Blocked host"],
	["not a url", "Invalid URL"],
] as const) {
	const decision = tenantEgressDecision(url);
	assert.equal(decision.decision, "deny", `${url} must be denied`);
	assert.equal(decision.reason, reason, `${url} must explain its denial`);
}

assert.match(
	runtimeSource,
	/CmsOutboundProxy\(\s*\{\s*props:\s*\{\s*siteId:\s*org\.siteId,\s*slug,\s*restoreEpoch\s*\}\s*,?\s*\}\s*\)/,
	"the loopback export factory must pin outbound calls to the site and restore epoch",
);
assert.match(
	runtimeSource,
	/globalOutbound:\s*tenantOutbound/,
	"the CMS Worker Loader manifest must route every tenant fetch through CmsOutboundProxy",
);
for (const flag of ["nodejs_compat", "global_fetch_strictly_public"]) {
	assert.match(
		runtimeSource,
		new RegExp(`compatibilityFlags:[\\s\\S]{0,240}?${flag}`),
		`the tenant isolate compatibility flags must include ${flag}`,
	);
}
assert.doesNotMatch(
	runtimeSource,
	/disallow_importable_env/,
	"CMS tenant bundles import env from cloudflare:workers and must retain that supported access path",
);
assert.match(
	proxySource,
	/event:\s*"cms\.tenant_egress"/,
	"every outbound decision must be observable without logging paths or query strings",
);
assert.match(
	proxySource,
	/redirect:\s*"manual"/,
	"an upstream redirect must not bypass the URL-level SSRF policy",
);

console.log("cms-runtime tenant egress check passed");
