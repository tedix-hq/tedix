/**
 * @tedix/auth - JWT Validation
 *
 * SDK-native validation via Descope's validateSession() — handles JWKS fetching,
 * key caching, rotation, and AIH MCP-server issuer support (node-sdk 2.5.0+).
 * Edge-compatible on all Cloudflare Workers with nodejs_compat.
 */

import type DescopeSdkFactory from "@descope/node-sdk";
import {
	type AudienceAuditEvent,
	type JWTPayload,
	type ValidateOptions,
} from "@tedix/auth/types";
import * as jose from "jose";

// =============================================================================
// SDK VALIDATION CLIENT CACHE
// =============================================================================

type DescopeValidationClient = ReturnType<typeof DescopeSdkFactory>;

const validationClients = new Map<string, DescopeValidationClient>();

export function normalizeDescopeBaseUrl(baseUrl?: string): string | undefined {
	const normalized = baseUrl?.trim().replace(/\/+$/, "");
	if (!normalized) return undefined;
	return normalized.replace(/\/v1\/apps$/, "");
}

async function getValidationClient(
	projectId: string,
	baseUrl?: string,
): Promise<DescopeValidationClient> {
	const normalizedBaseUrl = normalizeDescopeBaseUrl(baseUrl);
	const key = `${normalizedBaseUrl || "default"}:${projectId}`;
	let client = validationClients.get(key);
	if (!client) {
		const { default: DescopeSdk } = await import("@descope/node-sdk");
		client = DescopeSdk({ projectId, baseUrl: normalizedBaseUrl });
		validationClients.set(key, client);
	}
	return client;
}

// =============================================================================
// ERRORS
// =============================================================================

export class TokenValidationError extends Error {
	constructor(
		message: string,
		public readonly code: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "TokenValidationError";
	}
}

function mapTokenError(error: unknown, prefix = "Token"): never {
	if (error instanceof TokenValidationError) throw error;

	const msg = error instanceof Error ? error.message : String(error);
	const name = error instanceof Error ? error.name : "";

	if (
		name === "JWTExpired" ||
		msg.includes("expired") ||
		msg.includes('"exp" claim')
	) {
		throw new TokenValidationError("Token has expired", "TOKEN_EXPIRED", error);
	}
	if (
		name === "JWTClaimValidationFailed" ||
		msg.includes("audience") ||
		msg.includes("issuer") ||
		msg.includes("claim")
	) {
		throw new TokenValidationError(
			`Token claim validation failed: ${msg}`,
			"CLAIM_VALIDATION_FAILED",
			error,
		);
	}
	if (name === "JWSSignatureVerificationFailed" || msg.includes("signature")) {
		throw new TokenValidationError(
			"Token signature verification failed",
			"SIGNATURE_INVALID",
			error,
		);
	}

	throw new TokenValidationError(
		`${prefix} validation failed: ${msg}`,
		"VALIDATION_FAILED",
		error,
	);
}

// =============================================================================
// PAYLOAD NORMALIZATION
// =============================================================================

/**
 * Shape the SDK-verified claims without inventing any. `exp` and `iss` are
 * required (the Descope SDK already rejects a missing or foreign issuer and
 * rewrites it to the project ID); `iat` and `aud` pass through only when the
 * issuer emitted them, so a default can never stand in for issued authority.
 */
function normalizePayload(raw: Record<string, unknown>): JWTPayload {
	const exp = typeof raw.exp === "number" ? raw.exp : undefined;
	if (!exp) {
		throw new TokenValidationError(
			"Token is missing required exp claim",
			"CLAIM_VALIDATION_FAILED",
		);
	}
	if (typeof raw.iss !== "string" || !raw.iss) {
		throw new TokenValidationError(
			"Token is missing required iss claim",
			"CLAIM_VALIDATION_FAILED",
		);
	}

	const aud = audienceClaim(raw.aud);
	return {
		...raw,
		sub: typeof raw.sub === "string" ? raw.sub : undefined,
		email: typeof raw.email === "string" ? raw.email : undefined,
		name: typeof raw.name === "string" ? raw.name : undefined,
		picture: typeof raw.picture === "string" ? raw.picture : undefined,
		client_id:
			typeof raw.client_id === "string"
				? raw.client_id
				: typeof raw.azp === "string"
					? raw.azp
					: undefined,
		iat: typeof raw.iat === "number" ? raw.iat : undefined,
		exp,
		iss: raw.iss,
		aud,
	};
}

/** RFC 7519 `aud`: a string or an array of strings; anything else is absent. */
function audienceClaim(raw: unknown): string | string[] | undefined {
	if (typeof raw === "string") return raw;
	if (Array.isArray(raw) && raw.every((value) => typeof value === "string"))
		return raw;
	return undefined;
}

// =============================================================================
// AUDIENCE AUDIT (measurement for the enforcement rollout)
// =============================================================================

/** Normalize an `aud` claim, which is a string or an array per RFC 7519. */
function audienceList(raw: unknown): string[] {
	if (typeof raw === "string") return [raw];
	if (Array.isArray(raw)) return raw.filter((a) => typeof a === "string");
	return [];
}

/**
 * Pure: what would audience enforcement have done for this token?
 *
 * A token with no `aud` at all is NOT counted as a rejection — Tedix's own
 * session JWTs are not guaranteed to carry one (that is project-level JWT
 * template config), so treating absence as failure would swamp the signal with
 * traffic that enforcement would have to special-case anyway. It is reported
 * separately via `missingAudienceClaim` so the decision stays visible.
 */
export function computeAudienceAudit(
	audit: NonNullable<ValidateOptions["auditAudience"]>,
	rawAud: unknown,
	projectId: string,
): AudienceAuditEvent {
	const actual = audienceList(rawAud);
	const satisfiesExpected = actual.some((a) => audit.expected.includes(a));
	return {
		surface: audit.surface,
		expected: audit.expected,
		actual,
		wouldReject: actual.length > 0 && !satisfiesExpected,
		passedOnlyViaProjectId: !satisfiesExpected && actual.includes(projectId),
		missingAudienceClaim: actual.length === 0,
	};
}

// =============================================================================
// TOKEN VALIDATION
// =============================================================================

export async function validateToken(
	token: string,
	options: ValidateOptions,
): Promise<JWTPayload> {
	const { projectId, baseUrl, audience, allowedAudiences = [] } = options;

	if (!token)
		throw new TokenValidationError("Token is required", "MISSING_TOKEN");
	if (!projectId)
		throw new TokenValidationError(
			"Project ID is required",
			"MISSING_PROJECT_ID",
		);

	const primaryAudience = audience || projectId;

	try {
		const client = await getValidationClient(projectId, baseUrl);
		// Only enforce the `aud` claim when a caller explicitly asks for it
		// (e.g. the MCP edge scoping AIH tokens to a resource server).
		// Descope's own SDK treats audience checking as optional — see
		// "Basic validation without audience checking" in their session-
		// validation docs — and Tedix's own project/session JWTs are not
		// guaranteed to carry an `aud` claim (project-level JWT Template
		// config controls that, not this call site). Requiring it
		// unconditionally here would reject otherwise-valid, correctly
		// signed, correctly issued tokens.
		const audiences =
			audience || allowedAudiences.length > 0
				? [primaryAudience, ...allowedAudiences]
				: undefined;
		const authInfo = await client.validateSession(
			token,
			audiences ? { audience: audiences } : undefined,
		);
		const result = normalizePayload(authInfo.token as Record<string, unknown>);

		if (
			!options.allowTediJwt &&
			(result as Record<string, unknown>).entityType === "tedi"
		) {
			throw new TokenValidationError(
				"Tedi JWTs are not accepted on user auth paths",
				"TEDI_JWT_REJECTED",
			);
		}

		if (options.auditAudience) {
			// Measurement must never be able to reject traffic: this sits after the
			// token is fully accepted, and a throwing reporter is swallowed rather
			// than falling into mapTokenError, which would turn a logging bug into
			// an auth failure.
			try {
				options.auditAudience.report(
					computeAudienceAudit(
						options.auditAudience,
						(authInfo.token as Record<string, unknown>).aud,
						projectId,
					),
				);
			} catch {
				// An audit reporter is diagnostics only — never fail validation for it.
			}
		}

		return result;
	} catch (error) {
		mapTokenError(error);
	}
}

// =============================================================================
// DECODE HELPERS (no validation)
// =============================================================================

export function decodeTokenUnsafe(token: string): JWTPayload | null {
	try {
		const claims = jose.decodeJwt(token);
		return {
			...claims,
			iat: claims.iat ?? 0,
			exp: claims.exp ?? 0,
			iss: claims.iss ?? "",
			aud: claims.aud ?? "",
		} as JWTPayload;
	} catch {
		return null;
	}
}

export function isTokenExpired(
	token: string,
	clockTolerance = 60,
): boolean | null {
	const payload = decodeTokenUnsafe(token);
	if (!payload?.exp) return null;
	return payload.exp < Math.floor(Date.now() / 1000) - clockTolerance;
}

// =============================================================================
// TOKEN TYPE DETECTION
// =============================================================================

export function isM2MToken(payload: JWTPayload): boolean {
	return !!payload.client_id && !payload.sub && !payload.email;
}

/**
 * A `sub` claim alone does not prove a human: Descope's AIH M2M client-
 * credentials tokens are NOT guaranteed to omit `sub` (see
 * `shouldAttemptAihM2mScopeHydration` in apps/mcp/src/auth-helpers.ts, which
 * treats `hasClientId && !hasHumanEmail` — not `sub` presence/absence — as
 * the authoritative "this is a machine client" signal, because Descope's
 * SDK-normalized payload shape for these tokens is not fully self-describing).
 * A genuine human OAuth token (Descope AIH, e.g. a ChatGPT/Claude Desktop MCP
 * client login) legitimately carries `client_id` too — it identifies the
 * OAuth relying-party application, not a machine principal — so `client_id`
 * presence alone cannot be the signal either (see the "Descope AIH OAuth user
 * tokens" test case below). The combination this codebase already treats as
 * machine-shaped is `client_id` present AND `email` absent; mirror it here so
 * a token carrying an unexpected `sub` cannot pass as a human caller merely
 * by omitting the one field `isM2MToken` also requires to be absent.
 */
export function isUserToken(payload: JWTPayload): boolean {
	if (!payload.sub) return false;
	if (payload.entityType === "tedi" || typeof payload.tediId === "string") {
		return false;
	}
	if (payload.client_id && !payload.email) return false;
	return true;
}
