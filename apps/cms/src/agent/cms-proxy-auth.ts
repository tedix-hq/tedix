import {
	describeCmsHumanAuthDenial,
	encodeCmsHumanIdentity,
} from "./cms-human-auth";
import type { CmsProxyContext, ToolResult } from "./cms-proxy-runtime";

/** True when the token looks like a JWT (3 base64url segments). */
export function isJwt(token: string): boolean {
	const parts = token.split(".");
	return parts.length === 3 && parts.every((p) => /^[A-Za-z0-9_-]+$/.test(p));
}

export type AuthHeaderCandidate = {
	source: "jwt" | "pat" | "internal";
	headers: Record<string, string>;
};

/**
 * Build the ordered auth header candidates for an Emdash REST call.
 *
 * Emdash middleware (handleBearerAuth) only accepts ec_pat_* / ec_oat_* as
 * Authorization: Bearer — any other bearer token returns "invalid" (401)
 * immediately, before handleExternalAuth / the Descope adapter ever runs.
 *
 * Routing:
 *   Descope JWT             → Cookie: DS=<jwt>           (handleExternalAuth / Descope adapter path)
 *   PAT (ec_pat_*|ec_oat_*) → Authorization: Bearer     (handleBearerAuth path)
 *   Site Builder service binding  → X-Tedix-CMS-Internal-Auth (Descope adapter service principal path)
 */
export function buildCmsAuthHeaderCandidates(
	ctx: CmsProxyContext,
): AuthHeaderCandidate[] {
	const candidates: AuthHeaderCandidate[] = [];
	if (ctx.humanAuthRequired) {
		if (!ctx.humanIdentity || !ctx.internalAuthToken) return candidates;
		return [
			{
				source: "jwt",
				headers: {
					Accept: "application/json",
					"X-EmDash-Request": "1",
					"X-Tedix-CMS-Forwarded-User-Auth": ctx.internalAuthToken,
					"X-Tedix-CMS-Human-Identity": encodeCmsHumanIdentity(
						ctx.humanIdentity,
					),
				},
			},
		];
	}
	// Descope JWT — human session forwarded from MCP Worker.
	// Must not use Authorization: Bearer (handleBearerAuth rejects unknown formats).
	if (ctx.forwardedAuth && isJwt(ctx.forwardedAuth)) {
		candidates.push({
			source: "jwt",
			headers: {
				Accept: "application/json",
				Cookie: `DS=${ctx.forwardedAuth}`,
				...(ctx.internalAuthToken
					? { "X-Tedix-CMS-Forwarded-User-Auth": ctx.internalAuthToken }
					: {}),
				"X-EmDash-Request": "1",
			},
		});
		// A human session keeps its own Emdash permissions and attribution.
		// The platform admin is already authorized for every site and may recover
		// from a CMS cookie 401 through the trusted site credential below.
		if (!ctx.isPlatformAdmin) return candidates;
	}
	// PAT fallback — service context (tedi / automation).
	if (
		ctx.serviceApiKey?.startsWith("ec_pat_") ||
		ctx.serviceApiKey?.startsWith("ec_oat_")
	) {
		candidates.push({
			source: "pat",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${ctx.serviceApiKey}`,
				"X-EmDash-Request": "1",
			},
		});
	}
	// Trusted Site Builder Worker -> CMS Runtime service-binding path. Do not send
	// non-Emdash bearer tokens; Emdash's bearer middleware rejects unknown
	// token formats before the external auth provider can run.
	if (ctx.internalAuthToken) {
		candidates.push({
			source: "internal",
			headers: {
				Accept: "application/json",
				"X-Tedix-CMS-Internal-Auth": ctx.internalAuthToken,
				"X-EmDash-Request": "1",
			},
		});
	}
	return candidates;
}

/**
 * The reason no auth candidate exists for this call, so an operator can act on
 * the actual cause (a stale marker after a theme deploy, a missing role, an
 * unverified bearer, or no credential at all) instead of guessing at token
 * expiry. Never includes a token or key value.
 */
export function describeCmsAuthUnavailable(ctx: CmsProxyContext): string {
	if (ctx.humanAuthRequired) {
		if (ctx.humanIdentity && !ctx.internalAuthToken)
			return "Human CMS auth resolved but the Site Builder has no CMS_INTERNAL_AUTH_TOKEN to carry the assertion.";
		if (ctx.humanAuthDenial)
			return describeCmsHumanAuthDenial(ctx.humanAuthDenial);
		return describeCmsHumanAuthDenial({ reason: "unverified_bearer" });
	}
	return "No credential at all: no Emdash service PAT for this org (CMS_SERVICE_KEYS or cms_provision_service_key) and no CMS_INTERNAL_AUTH_TOKEN configured.";
}

export function cmsAuthUnavailableToolResult(ctx: CmsProxyContext): ToolResult {
	return {
		content: [
			{
				type: "text",
				text: `[UNAUTHORIZED] ${describeCmsAuthUnavailable(ctx)}`,
			},
		],
		isError: true,
	};
}
