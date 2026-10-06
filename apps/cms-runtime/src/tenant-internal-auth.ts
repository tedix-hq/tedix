/**
 * Tenant internal-auth de-scoping.
 *
 * `CMS_INTERNAL_AUTH_TOKEN` is a Worker-level shared secret: the Studio Worker
 * presents it as `X-Tedix-CMS-Internal-Auth` (see
 * `apps/cms/src/agent/cms-proxy.ts` `buildCmsAuthHeaderCandidates`) and the
 * bundled tenant auth module (`apps/cms/templates/*\/src/auth/descope.ts`
 * `authenticateInternalRequest`) authenticates the caller as the
 * `tedix-cms-service` admin principal when the header matches its own
 * `env.CMS_INTERNAL_AUTH_TOKEN`.
 *
 * That comparison is the token's only use inside a tenant isolate — it is never
 * sent outbound (the newsletter and tedi-bridge plugins authenticate to the
 * platform API with a per-tenant `platformApiKey` setting, not with this
 * token). But handing the raw shared secret to every tenant bundle means one
 * compromised npm dependency in one tenant build reads a credential that
 * authenticates as admin against every other tenant.
 *
 * So the parent keeps the shared secret and does the authentication itself:
 *
 *   1. `deriveTenantInternalAuthToken()` mints a per-tenant, per-bundle value
 *      HMAC'd under the shared secret. That derived value — not the secret —
 *      is what goes into the isolate's `CMS_INTERNAL_AUTH_TOKEN`. It is
 *      bound to the site's restore epoch, so the loader factory (cache miss only) and the request
 *      path always agree without extra state.
 *   2. `rewriteTenantInternalAuthHeader()` runs parent-side on every dispatch:
 *      a header matching the real shared secret is rewritten to that tenant's
 *      derived value; anything else is neutralized.
 *
 * Net effect: the isolate's equality check still succeeds for exactly the
 * requests it accepted before, and a leaked derived value grants nothing
 * outside the isolate that already held it. The tenant bundle is unchanged, so
 * this holds for bundles already built and live in R2.
 */

const HMAC_INFO = "tedix-cms-internal-auth:v1";

export const INTERNAL_AUTH_HEADER = "X-Tedix-CMS-Internal-Auth";

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
	return Array.from(new Uint8Array(buffer))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

/**
 * Length-independent equality. The parent compares attacker-controlled input
 * against the shared secret here, so it must not leak a prefix length.
 */
export function constantTimeEquals(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}

/**
 * Per-tenant internal-auth value injected into the isolate in place of the
 * shared secret. Bound to the slug (no cross-tenant reuse) and to the bundle
 * version and restore epoch (either change rotates it). Returns `undefined` when the parent Worker
 * has no shared secret configured — matching today's behaviour, where the
 * tenant simply never authenticates an internal request.
 */
export async function deriveTenantInternalAuthToken(
	sharedToken: string | undefined,
	slug: string,
	bundleVersion: number,
	restoreEpoch: number,
): Promise<string | undefined> {
	if (!sharedToken) return undefined;
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(sharedToken),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		encoder.encode(`${HMAC_INFO}:${slug}:${bundleVersion}:${restoreEpoch}`),
	);
	return toHex(signature);
}

/**
 * Translate the inbound internal-auth header into the tenant-scoped value the
 * isolate holds. Requests without the header are passed through untouched so
 * the public hot path allocates nothing.
 */
export function rewriteTenantInternalAuthHeader(
	request: Request,
	args: { sharedToken: string | undefined; tenantToken: string | undefined },
): Request {
	const presented = request.headers.get(INTERNAL_AUTH_HEADER);
	if (presented === null) return request;

	const headers = new Headers(request.headers);
	const { sharedToken, tenantToken } = args;
	if (
		sharedToken &&
		tenantToken &&
		constantTimeEquals(presented, sharedToken)
	) {
		headers.set(INTERNAL_AUTH_HEADER, tenantToken);
	} else {
		// Neutralize rather than `delete`: `new Request(request, { headers })` is
		// the only clone form that carries `request.cf` through to the isolate,
		// and its init-headers semantics differ across runtimes — workerd
		// replaces the header list, Bun merges it, so a delete can silently
		// survive as the original value. An empty value is dropped by both and
		// is rejected identically by the tenant's `!actual` check
		// (templates/*/src/auth/descope.ts authenticateInternalRequest).
		headers.set(INTERNAL_AUTH_HEADER, "");
	}
	return new Request(request, { headers });
}
