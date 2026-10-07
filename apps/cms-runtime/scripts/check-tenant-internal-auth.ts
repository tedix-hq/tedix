/**
 * The Worker-level `CMS_INTERNAL_AUTH_TOKEN` must never reach a tenant isolate.
 *
 * Tenant bundles pull npm plugins (see `apps/cms/src/template-snapshot.ts`), so
 * anything in the isolate `env` map is readable by third-party build output.
 * The parent authenticates the Studio internal-auth header itself and injects
 * only a per-tenant derivation — see `src/tenant-internal-auth.ts`.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
	INTERNAL_AUTH_HEADER,
	constantTimeEquals,
	deriveTenantInternalAuthToken,
	rewriteTenantInternalAuthHeader,
} from "../src/tenant-internal-auth";

const repoRoot = new URL("../../..", import.meta.url).pathname;
const runtimeSource = readFileSync(
	join(repoRoot, "apps/cms-runtime/src/index.ts"),
	"utf8",
);

const SHARED = "cms_internal_shared_secret_value";

// ── derivation ────────────────────────────────────────────────────────

const tedix = await deriveTenantInternalAuthToken(SHARED, "tedix", 42, 0);
const acme = await deriveTenantInternalAuthToken(SHARED, "acme", 42, 0);
const tedixNextBundle = await deriveTenantInternalAuthToken(
	SHARED,
	"tedix",
	43,
	0,
);
const rotated = await deriveTenantInternalAuthToken(
	"a_different_shared_secret_x",
	"tedix",
	42,
	0,
);

assert.ok(tedix, "a configured shared secret must yield a tenant token");
assert.equal(
	tedix,
	await deriveTenantInternalAuthToken(SHARED, "tedix", 42, 0),
	"tenant internal-auth derivation must be deterministic — the loader factory runs only on a cache miss, the request path derives on every dispatch, and the two must agree",
);
assert.notEqual(
	tedix,
	acme,
	"one tenant's internal-auth value must not authenticate against another tenant",
);
assert.notEqual(
	tedix,
	tedixNextBundle,
	"redeploying a tenant bundle must rotate its internal-auth value",
);
assert.notEqual(
	tedix,
	rotated,
	"rotating CMS_INTERNAL_AUTH_TOKEN must rotate every tenant's derived value",
);
assert.notEqual(
	tedix,
	await deriveTenantInternalAuthToken(SHARED, "tedix", 42, 1),
	"closing a restore fence must rotate the tenant internal-auth value",
);
assert.ok(
	!tedix.includes(SHARED) && !SHARED.includes(tedix),
	"the derived value must not carry raw shared-secret material",
);
assert.equal(
	await deriveTenantInternalAuthToken(undefined, "tedix", 42, 0),
	undefined,
	"an unconfigured parent secret must stay unconfigured in the isolate, not fall back to a constant",
);

// ── header rewrite: the operation a Studio call must still reach ──────

const authorized = rewriteTenantInternalAuthHeader(
	new Request("https://tedix.cms.tedix.dev/_emdash/api/collections/posts", {
		method: "POST",
		body: '{"title":"hello"}',
		headers: {
			[INTERNAL_AUTH_HEADER]: SHARED,
			"X-EmDash-Request": "1",
			"content-type": "application/json",
		},
	}),
	{ sharedToken: SHARED, tenantToken: tedix },
);
assert.equal(
	authorized.headers.get(INTERNAL_AUTH_HEADER),
	tedix,
	"a genuine Studio internal-auth header must arrive as the value this tenant's isolate compares against (templates/*/src/auth/descope.ts authenticateInternalRequest), so the tedix-cms-service admin path still works",
);
assert.equal(
	authorized.headers.get("X-EmDash-Request"),
	"1",
	"rewriting must preserve the rest of the Studio request headers",
);
assert.equal(
	authorized.method,
	"POST",
	"rewriting must preserve the request method",
);
assert.equal(
	await authorized.text(),
	'{"title":"hello"}',
	"rewriting must preserve the request body",
);

/**
 * Rejected values are neutralized to "" rather than deleted — the clone form
 * that preserves `request.cf` has runtime-dependent delete semantics. Both ""
 * and absent are rejected by the tenant's `!actual` check, and neither carries
 * secret material.
 */
function assertNeutralized(request: Request, message: string): void {
	const value = request.headers.get(INTERNAL_AUTH_HEADER);
	assert.ok(value === null || value === "", message);
}

assertNeutralized(
	rewriteTenantInternalAuthHeader(
		new Request("https://tedix.cms.tedix.dev/", {
			headers: { [INTERNAL_AUTH_HEADER]: "guessed_token" },
		}),
		{ sharedToken: SHARED, tenantToken: tedix },
	),
	"an unverified internal-auth header must never be forwarded into the isolate",
);

assertNeutralized(
	rewriteTenantInternalAuthHeader(
		new Request("https://acme.cms.tedix.dev/", {
			headers: { [INTERNAL_AUTH_HEADER]: tedix },
		}),
		{ sharedToken: SHARED, tenantToken: acme },
	),
	"a value leaked from one tenant isolate must not authenticate against another tenant",
);

assertNeutralized(
	rewriteTenantInternalAuthHeader(
		new Request("https://tedix.cms.tedix.dev/", {
			headers: { [INTERNAL_AUTH_HEADER]: SHARED },
		}),
		{ sharedToken: undefined, tenantToken: undefined },
	),
	"with no parent secret configured no internal-auth header may reach the isolate",
);

const publicRequest = new Request("https://tedix.cms.tedix.dev/blog");
assert.equal(
	rewriteTenantInternalAuthHeader(publicRequest, {
		sharedToken: SHARED,
		tenantToken: tedix,
	}),
	publicRequest,
	"the public hot path must pass through untouched",
);

assert.ok(
	constantTimeEquals(SHARED, SHARED) &&
		!constantTimeEquals(SHARED, `${SHARED}x`) &&
		!constantTimeEquals(SHARED, "cms_internal_shared_secret_valuX"),
	"internal-auth comparison must be exact and length-independent",
);

// ── isolate env map ───────────────────────────────────────────────────

const factoryStart = runtimeSource.indexOf(
	"const handle = withDynamicWorkerLoaderDiagnostics(env.LOADER, {",
);
const factoryEnd = runtimeSource.indexOf(
	"return handle.getEntrypoint();",
	factoryStart,
);
assert.ok(
	factoryStart !== -1 && factoryEnd > factoryStart,
	"could not locate the Worker Loader manifest factory in apps/cms-runtime/src/index.ts — this check must be repointed, not deleted",
);
const loaderEnvMap = runtimeSource.slice(factoryStart, factoryEnd);

for (const secret of [
	"CMS_INTERNAL_AUTH_TOKEN",
	"CLOUDFLARE_R2_API_TOKEN",
	"LEAD_FORM_IP_HASH_HMAC_KEY",
]) {
	assert.ok(
		!loaderEnvMap.includes(`env.${secret}`),
		`the tenant isolate env map must not read the parent Worker secret ${secret} — hand untrusted bundle code a scoped capability instead`,
	);
}

assert.match(
	loaderEnvMap,
	/internalAuthToken\s*\n?\s*\?\s*\{\s*CMS_INTERNAL_AUTH_TOKEN: internalAuthToken/,
	"the isolate's CMS_INTERNAL_AUTH_TOKEN must come from the per-tenant derivation, not the shared secret",
);

assert.match(
	runtimeSource,
	/let tenantRequest = rewriteTenantInternalAuthHeader\(normalizedRequest, \{[\s\S]{0,200}?sharedToken: env\.CMS_INTERNAL_AUTH_TOKEN[\s\S]*?protectLeadFormIp\(tenantRequest,[\s\S]*?tenantRequest = protectedTenantRequest;[\s\S]*?fetchTenant\(tenantRequest\)/,
	"the parent must apply both internal-auth and lead-IP de-scoping before tenant dispatch",
);

assert.match(
	runtimeSource,
	/const fetchTenant = \(tenantFetchRequest: Request\) =>\s*fetchWithTenantLoaderRecovery\(\s*tenantFetchRequest,/,
	"the tenant fetch helper must forward only its already-protected request",
);

assert.doesNotMatch(
	runtimeSource,
	/tenantEntrypoint\.fetch\(normalizedRequest\)/,
	"the un-rewritten request must never reach a tenant isolate",
);

console.log("cms-runtime tenant internal-auth check passed");
