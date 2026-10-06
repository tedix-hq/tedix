/**
 * @tedix/auth - RFC 9207 authorization-response `iss` validation
 *
 * Shared client-side check applied to every Tedix-handled OAuth authorization
 * response (ADR: docs/decisions/tedi-client-oauth-cimd.md, phase 1). The
 * client records the issuer it expects (from validated RFC 8414
 * authorization-server metadata) before redirecting, then compares any `iss`
 * parameter in the authorization response against it BEFORE the authorization
 * code touches a token endpoint. This defeats authorization-server mix-up
 * attacks: a response minted by (or replayed through) a different AS carries a
 * different `iss` and is rejected without ever redeeming the code.
 *
 * Decision table (RFC 9207 §2.4):
 * - `iss` present and equal to the expected issuer → accept (validated).
 * - `iss` present and different → reject (`iss_mismatch`).
 * - `iss` absent while the AS advertises
 *   `authorization_response_iss_parameter_supported: true` → reject
 *   (`iss_missing` — an attacker can strip the parameter, so absence on a
 *   supporting AS is treated as tampering).
 * - `iss` absent and the AS does not advertise support → accept, with a
 *   structured warning (the check cannot run; callers should surface it).
 *
 * Comparison is the RFC 9207 simple string comparison (RFC 3986 §6.2.1 byte
 * equality) — no case folding, default-port elision, trailing-slash handling,
 * percent-decoding, or path rewriting. Discovery-time issuer pinning has a
 * separate normalization contract and must not weaken this response check.
 */

import { trimTrailingSlashes } from "./utils.ts";

export type AuthorizationResponseIssRejection = "iss_mismatch" | "iss_missing";

/**
 * Issuer-pin drift refusal (ADR phase 1a).
 *
 * The first successful MCP OAuth discovery pins the RFC 8414-validated
 * authorization-server issuer on the provider record. Any later discovery
 * (rescan/reconnect) that resolves the same provider to a *different* issuer
 * is the MCP specification's authorization-server-binding violation: credentials
 * and vaulted tokens bound to the pinned issuer must never be silently
 * re-provisioned against a new one. Callers refuse fail-closed and surface
 * the drift to an operator instead of updating the pin.
 */
export class IssuerPinDriftError extends Error {
	readonly code = "issuer_pin_drift" as const;
	readonly providerId: string;
	readonly pinnedIssuer: string;
	readonly discoveredIssuer: string;

	constructor(params: {
		providerId: string;
		pinnedIssuer: string;
		discoveredIssuer: string;
	}) {
		super(
			`Authorization-server issuer drift for provider "${params.providerId}": ` +
				`discovery now resolves issuer "${params.discoveredIssuer}" but this ` +
				`provider is pinned to issuer "${params.pinnedIssuer}". Refusing to ` +
				`re-provision against a changed authorization server (MCP ` +
				`authorization-server-binding rule; ADR tedi-client-oauth-cimd ` +
				`phase 1a). If the upstream issuer change is legitimate and vetted, ` +
				`an operator must clear or update the pinned issuer explicitly.`,
		);
		this.name = "IssuerPinDriftError";
		this.providerId = params.providerId;
		this.pinnedIssuer = params.pinnedIssuer;
		this.discoveredIssuer = params.discoveredIssuer;
	}
}

/**
 * Compare a freshly discovered authorization-server issuer against the pinned
 * issuer recorded on the provider row.
 *
 * - No pin (`null`/`undefined`/empty) → no-op: legacy rows behave exactly as
 *   before pinning existed; the caller pins after this discovery succeeds.
 * - Pin matches (same trailing-slash normalization as the RFC 8414 §3.3
 *   discovery-time check) → no-op.
 * - Pin differs → throws {@link IssuerPinDriftError}; the caller must refuse
 *   the rescan/reconnect fail-closed.
 */
export function assertPinnedIssuerMatches(params: {
	providerId: string;
	pinnedIssuer: string | null | undefined;
	discoveredIssuer: string;
}): void {
	const { providerId, pinnedIssuer, discoveredIssuer } = params;
	if (typeof pinnedIssuer !== "string" || pinnedIssuer.length === 0) return;
	if (
		normalizeIssuerForComparison(pinnedIssuer) !==
		normalizeIssuerForComparison(discoveredIssuer)
	) {
		throw new IssuerPinDriftError({
			providerId,
			pinnedIssuer,
			discoveredIssuer,
		});
	}
}

export class AuthorizationResponseIssError extends Error {
	readonly code: AuthorizationResponseIssRejection;
	readonly expectedIssuer: string;
	readonly responseIss: string | null;

	constructor(params: {
		code: AuthorizationResponseIssRejection;
		expectedIssuer: string;
		responseIss: string | null;
		message: string;
	}) {
		super(params.message);
		this.name = "AuthorizationResponseIssError";
		this.code = params.code;
		this.expectedIssuer = params.expectedIssuer;
		this.responseIss = params.responseIss;
	}
}

export interface AuthorizationResponseIssWarning {
	code: "iss_absent_as_unsupported";
	message: string;
}

export type AuthorizationResponseIssAccepted =
	| {
			/** `iss` was present and byte-equal to the expected issuer. */
			validated: true;
	  }
	| {
			/**
			 * `iss` was absent and the AS does not advertise
			 * `authorization_response_iss_parameter_supported`; the check could not
			 * run. Callers should log/surface the warning.
			 */
			validated: false;
			warning: AuthorizationResponseIssWarning;
	  };

/**
 * Normalize an issuer identifier for discovery and stored-pin comparison.
 *
 * This helper exists for the RFC 8414 metadata/pin path, where Tedix has an
 * explicit trailing-slash compatibility contract. Never use it for an RFC
 * 9207 authorization-response `iss`: the MCP authorization specification
 * requires simple string comparison without trailing-slash normalization.
 */
export function normalizeIssuerForComparison(value: string): string {
	return trimTrailingSlashes(value);
}

/**
 * RFC 9207 authorization-response `iss` check. Call it on every
 * Tedix-handled authorization response (success or error) before the
 * authorization code is sent to any token endpoint.
 *
 * @param expectedIssuer - The issuer identifier recorded from validated AS
 *   metadata before the redirect was issued.
 * @param responseIss - The `iss` query parameter from the authorization
 *   response, or null/undefined when absent. Empty string counts as absent.
 * @param issSupported - Whether the AS metadata advertised
 *   `authorization_response_iss_parameter_supported: true`.
 * @returns The accepted-branch result (validated, or allowed-with-warning).
 * @throws AuthorizationResponseIssError on mismatch, or on absence when the
 *   AS advertises support.
 */
export function assertAuthorizationResponseIss(params: {
	expectedIssuer: string;
	responseIss: string | null | undefined;
	issSupported: boolean;
}): AuthorizationResponseIssAccepted {
	const { expectedIssuer, issSupported } = params;
	const responseIss =
		typeof params.responseIss === "string" && params.responseIss.length > 0
			? params.responseIss
			: null;

	if (responseIss !== null) {
		if (responseIss !== expectedIssuer) {
			throw new AuthorizationResponseIssError({
				code: "iss_mismatch",
				expectedIssuer,
				responseIss,
				message:
					`Authorization response issuer mismatch: response carries iss ` +
					`"${responseIss}" but this flow was initiated against issuer ` +
					`"${expectedIssuer}". Refusing to redeem the authorization code ` +
					`(RFC 9207 mix-up defense).`,
			});
		}
		return { validated: true };
	}

	if (issSupported) {
		throw new AuthorizationResponseIssError({
			code: "iss_missing",
			expectedIssuer,
			responseIss: null,
			message:
				`Authorization response is missing the iss parameter, but issuer ` +
				`"${expectedIssuer}" advertises ` +
				`authorization_response_iss_parameter_supported. Treating the ` +
				`stripped parameter as tampering and refusing to redeem the ` +
				`authorization code (RFC 9207).`,
		});
	}

	return {
		validated: false,
		warning: {
			code: "iss_absent_as_unsupported",
			message:
				`Authorization response carries no iss parameter and issuer ` +
				`"${expectedIssuer}" does not advertise ` +
				`authorization_response_iss_parameter_supported; RFC 9207 mix-up ` +
				`protection could not be applied to this response.`,
		},
	};
}
